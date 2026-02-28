const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');

// 溫度記錄服務
const { initTemperatureLogger, startTemperatureLogging, getLoggerStatus } = require('./lib/temperature-logger');
const { initTimeSync, startPeriodicTimeSync } = require('./lib/ntp-client');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ==========================================
// MQTT 配置
// ==========================================
const MQTT_BROKER = 'mqtt://broker.emqx.io';
const MQTT_OPTIONS = {
    clientId: `nextjs_server_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 1000,
};

// 用來追蹤已訂閱的 plugID，避免重複訂閱
const subscribedPlugs = new Set();

// ==========================================
// 狀態管理
// ==========================================
// wsClients 結構: Map<clientId, { ws: WebSocket, plugId: string }>
const wsClients = new Map();

// 用來快速查找某個 plugID 有哪些 client 在線
// plugClients 結構: Map<plugId, Set<clientId>>
const plugClients = new Map();

// 初始化 MQTT
console.log('🔌 正在連接 MQTT Broker...');
const mqttClient = mqtt.connect(MQTT_BROKER, MQTT_OPTIONS);

mqttClient.on('connect', () => {
    console.log(`✅ MQTT 已連接: ${MQTT_BROKER}`);
    // 伺服器重啟後，如果記憶體中有連線，需重新訂閱 (這在 HMR 重啟時很有用)
    subscribedPlugs.forEach(plugId => {
        const topic = `smartplug/${plugId}/#`;
        mqttClient.subscribe(topic);
        console.log(`📡 [Re-Sub] 重新訂閱: ${topic}`);
    });
});

mqttClient.on('error', (err) => {
    console.error('❌ MQTT 連接錯誤:', err);
});

// ==========================================
// 處理 MQTT 收到的訊息 (ESP32 -> Server -> UI)
// ==========================================
mqttClient.on('message', (topic, message) => {
    try {
        const msgString = message.toString();
        // Topic 範例: smartplug/A001/temperature
        const parts = topic.split('/');

        // 格式檢查: smartplug/{plugID}/{category}/{subcategory?}
        if (parts.length < 3 || parts[0] !== 'smartplug') return;

        const plugId = parts[1];
        const category = parts[2];     // e.g., relay, temperature, voltage
        const subCategory = parts[3];  // e.g., state, name (only for relay)

        const payload = JSON.parse(msgString);

        // 準備發送給前端的數據包
        let frontendData = null;

        // 根據規範 3 進行路由處理
        if (category === 'temperature') {
            // Topic: smartplug/{plugID}/temperature
            // Payload: {"temperature": 25.5}
            frontendData = {
                type: 'sensor_data',
                temperature: payload.temperature
            };
        }
        else if (category === 'voltage') {
            // Topic: smartplug/{plugID}/voltage
            // Payload: {"voltage": 110}
            frontendData = {
                type: 'sensor_data',
                voltage: payload.voltage // 需確認前端是否有處理 voltage
            };
        }
        else if (category === 'relay') {
            if (subCategory === 'state') {
                // Topic: smartplug/{plugID}/relay/state
                // Payload: {"id": 0, "state": "1"}
                frontendData = {
                    type: 'relay_response',
                    relay_id: payload.id,
                    state: payload.state === "1" // 轉回 boolean 給 React
                };
            } else if (subCategory === 'name') {
                // Topic: smartplug/{plugID}/relay/name
                // Payload: {"id": 0, "name": "客廳燈"}
                frontendData = {
                    type: 'relay_name_updated',
                    relay_id: payload.id,
                    name: payload.name
                };
            }
        }
        else if (category === 'plugName') {
            // Topic: smartplug/{plugID}/plugName
            // Payload: {"plugName": "我的插座"}
            frontendData = {
                type: 'plug_name_updated',
                plugName: payload.plugName
            };
        }
        else if (category === 'status' || category === 'error') {
            // Topic: smartplug/{plugID}/status 或 error
            console.log(`[${plugId}] ${category}:`, payload);
        }

        // 如果有解析出數據，廣播給該 PlugID 下的所有 WebSocket 用戶
        if (frontendData) {
            broadcastToPlug(plugId, frontendData);
        }

    } catch (e) {
        console.error(`解析 MQTT 訊息失敗 [${topic}]:`, e.message);
    }
});

// 廣播給特定 PlugID 的所有連線者
function broadcastToPlug(plugId, data) {
    const clients = plugClients.get(plugId);
    if (!clients) return;

    const message = JSON.stringify(data);
    clients.forEach(clientId => {
        const client = wsClients.get(clientId);
        if (client && client.ws.readyState === 1) {
            client.ws.send(message);
        }
    });
}

// ==========================================
// 處理 WebSocket 訊息 (UI -> Server -> MQTT)
// ==========================================
function handleWsMessage(msg, ws, clientId, plugId) {
    try {
        const data = JSON.parse(msg);
        console.log(`📨 WS收到指令 [${plugId}][${clientId}]:`, data.command);

        // 根據規範 2 發送 MQTT
        switch (data.command) {
            case 'relay_control':
                // 前端: { relay_id: 0, state: true }
                // MQTT: smartplug/{plugID}/{clientId}/control 
                // Payload: {"id": 0, "state": "1"}
                if (data.relay_id !== undefined) {
                    const topic = `smartplug/${plugId}/${clientId}/control`;
                    const payload = JSON.stringify({
                        id: data.relay_id,
                        state: data.state ? "1" : "0" // 轉換為規範的 "1"/"0"
                    });
                    mqttClient.publish(topic, payload);
                }
                break;

            case 'rename_relay': // 假設前端新增了這個 command
                // MQTT: smartplug/{plugID}/{clientId}/name
                const nameTopic = `smartplug/${plugId}/${clientId}/name`;
                mqttClient.publish(nameTopic, JSON.stringify({
                    id: data.relay_id,
                    name: data.name
                }));
                break;

            case 'get_sensors': // 初始化請求
                // MQTT: smartplug/{plugID}/{clientId}/request
                // 用來觸發 ESP32 回報所有狀態
                const reqTopic = `smartplug/${plugId}/${clientId}/request`;

                // 發送多個請求以獲取完整狀態
                mqttClient.publish(reqTopic, JSON.stringify({ type: "getPlugName" }));
                mqttClient.publish(reqTopic, JSON.stringify({ type: "voltage" }));
                // 你可能需要在 ESP32 實作一個 {type: "all"} 來一次回傳所有 relay 狀態
                // 這裡暫時模擬回傳，確保前端剛連線有數據顯示
                ws.send(JSON.stringify({
                    type: 'sensor_data',
                    temperature: 0, // 等待 MQTT 更新
                }));
                break;

            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    } catch (e) {
        console.error('處理 WS 訊息失敗:', e);
    }
}

// 初始化溫度記錄服務
async function initializeServices() {
    try {
        console.log('🕒 正在初始化時間同步服務...');
        await initTimeSync();
        startPeriodicTimeSync(60); // 每小時同步一次
        
        console.log('📝 正在初始化溫度記錄服務...');
        await initTemperatureLogger();
        
        // 獲取當前溫度的函數（從 MQTT 中獲取）
        const getCurrentTemperature = () => {
            // 這裡需要從 MQTT 訂閱中獲取溫度
            // 暫時返回一個預設值，實際使用時會從 MQTT 數據中獲取
            return 25.0; // 預設溫度
        };
        
        // 啟動溫度記錄（每30分鐘記錄一次）
        startTemperatureLogging(getCurrentTemperature, 30);
        
        console.log('✅ 所有服務初始化完成');
        console.log('📊 溫度記錄服務狀態:', getLoggerStatus());
        
    } catch (error) {
        console.error('❌ 服務初始化失敗:', error);
    }
}

// 處理溫度相關的 MQTT 訊息
function setupTemperatureHandling() {
    // 這個函數會從 MQTT 中獲取實際溫度數據
    let currentTemperature = 25.0;
    
    mqttClient.on('message', (topic, message) => {
        try {
            const msgString = message.toString();
            const parts = topic.split('/');
            
            if (parts.length < 3 || parts[0] !== 'smartplug') return;
            
            const category = parts[2];
            const payload = JSON.parse(msgString);
            
            // 如果是溫度訊息，更新當前溫度
            if (category === 'temperature' && payload.temperature !== undefined) {
                currentTemperature = payload.temperature;
                console.log(`🌡️ 收到溫度數據: ${currentTemperature}°C`);
            }
        } catch (e) {
            // 忽略解析錯誤
        }
    });
}

// 在應用準備完成後初始化服務
app.prepare().then(async () => {
    // 初始化服務
    await initializeServices();
    
    // 設定溫度處理
    setupTemperatureHandling();
    
    const server = createServer(async (req, res) => {
        try {
            const parsedUrl = parse(req.url, true);
            await handle(req, res, parsedUrl);
        } catch (err) {
            console.error('處理 HTTP 錯誤:', err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    });

    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws, request) => {
        try {
            console.log('╔═══════════════════════════════════════════════╗');
            console.log('║   WebSocket 連接建立                          ║');
            console.log('╚═══════════════════════════════════════════════╝');
            console.log('📋 請求 URL:', request.url);
            console.log('📋 請求頭:', JSON.stringify(request.headers, null, 2));
            
            const url = new URL(request.url, `http://${request.headers.host}`);
            const clientId = url.searchParams.get('clientId') || `user_${Date.now()}`;
            const plugId = url.searchParams.get('plugId'); // ⚠️ 必須從前端獲取

            console.log(`📋 解析參數: clientId=${clientId}, plugId=${plugId}`);

            if (!plugId) {
                console.warn(`❌ 連接拒絕: 缺少 plugId (ClientId: ${clientId})`);
                ws.close(1008, 'PlugID Required');
                return;
            }

            console.log(`🔌 新連線: User=[${clientId}] -> Plug=[${plugId}]`);

            // 1. 儲存連線關係
            wsClients.set(clientId, { ws, plugId });

            if (!plugClients.has(plugId)) {
                plugClients.set(plugId, new Set());
            }
            plugClients.get(plugId).add(clientId);

            // 2. 動態訂閱 MQTT (如果是該 PlugID 的第一個使用者)
            if (!subscribedPlugs.has(plugId)) {
                const topic = `smartplug/${plugId}/#`; // 訂閱該插座的所有消息
                console.log(`📡 嘗試訂閱 MQTT Topic: ${topic}`);
                mqttClient.subscribe(topic, (err) => {
                    if (!err) {
                        console.log(`✅ 已訂閱 MQTT Topic: ${topic}`);
                        subscribedPlugs.add(plugId);
                    } else {
                        console.error(`❌ 訂閱 MQTT Topic 失敗: ${topic}`, err);
                    }
                });
            }

            // 3. 發送歡迎訊息
            try {
                const welcomeMsg = JSON.stringify({
                    type: 'connected',
                    message: 'WebSocket 連接成功',
                    clientId: clientId,
                    plugId: plugId,
                    timestamp: Date.now()
                });
                ws.send(welcomeMsg);
                console.log(`✅ 已發送歡迎訊息給客戶端 ${clientId}`);
            } catch (sendError) {
                console.error('❌ 發送歡迎訊息失敗:', sendError);
            }

            ws.on('message', (message) => {
                console.log(`📨 收到訊息 [${clientId}]:`, message.toString().substring(0, 100));
                handleWsMessage(message.toString(), ws, clientId, plugId);
            });

            ws.on('close', (code, reason) => {
                console.log(`👋 斷開連線: ${clientId}`);
                console.log(`   - 關閉代碼: ${code}`);
                console.log(`   - 原因: ${reason || '無'}`);
                wsClients.delete(clientId);
                if (plugClients.has(plugId)) {
                    plugClients.get(plugId).delete(clientId);
                    // 為了保持活躍度，通常我們不立即取消訂閱 MQTT，
                    // 因為可能馬上又有別人連進來。
                }
            });

            ws.on('error', (error) => {
                console.error(`❌ WebSocket 錯誤 [${clientId}]:`, error);
            });

        } catch (error) {
            console.error('❌ WebSocket 連接處理異常:', error);
            try {
                ws.close(1011, 'Internal Server Error');
            } catch (closeError) {
                console.error('關閉 WebSocket 失敗:', closeError);
            }
        }
    });

    // 處理 Upgrade 請求 (包含 HMR 修復)
    server.on('upgrade', (request, socket, head) => {
        const { pathname } = parse(request.url);

        if (pathname === '/api/ws/operation') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (pathname.startsWith('/_next/')) {
            // ✅ 讓 Next.js 處理 HMR
            return;
        } else {
            socket.destroy();
        }
    });

    server.listen(port, hostname, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://${hostname}:${port}`);
        console.log(`> MQTT Bridge 模式已啟動`);
    });
});