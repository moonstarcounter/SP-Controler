const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// 溫度記錄服務
const { initTemperatureLogger, startTemperatureLogging, getLoggerStatus } = require('./lib/temperature-logger');
const { initTimeSync, startPeriodicTimeSync } = require('./lib/ntp-client');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ==========================================
// MQTT 配置 (由 lib/mqtt-shared 管理)
// ==========================================
const mqttShared = require('./lib/mqtt-shared');

// 用來追蹤已訂閱的 plugID，避免重複訂閱
const subscribedPlugs = new Set();

// 用來追蹤 WebSocket 客戶端
const wsClients = new Map(); // clientId -> { ws, plugId }
const plugClients = new Map(); // plugId -> Set(clientId)
const plugStates = new Map(); // plugId -> { relays: Map(id -> {state, name}) }

function getOrCreatePlugState(plugId) {
    if (!plugStates.has(plugId)) {
        plugStates.set(plugId, {
            relays: new Map()
        });
    }
    return plugStates.get(plugId);
}

// 監聽 MQTT 狀態變化並廣播給對應的 WS 客戶端
mqttShared.on('statusChange', (clientId, status) => {
    console.log(`📢 [Server] [${clientId}] MQTT 狀態變更: ${status}`);
    const client = wsClients.get(clientId);
    if (client && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({
            type: 'mqtt_status',
            connected: status === 'connected',
            status: status
        }));
    }
});

// 重啟或連線後為該 Client 訂閱其對應的 PlugID
mqttShared.on('connect', (clientId) => {
    const wsInfo = wsClients.get(clientId);
    if (!wsInfo) return;

    const mqttClient = mqttShared.getClient(clientId);
    if (!mqttClient) return;

    const topic = `smartplug/${wsInfo.plugId}/#`;
    mqttClient.subscribe(topic);
    console.log(`📡 [Shared-Sub] [${clientId}] 訂閱: ${topic}`);
});

// 全域訊息同步：當任何一個 MQTT 連線收到 plugId 的狀態更新，同步給所有關注該 plugId 的 WS
mqttShared.on('global_message', (topic, message, sourceClientId) => {
    // 解析主題獲取 plugId
    const parts = topic.split('/');
    if (parts.length < 2) return;
    const plugId = parts[1];

    let wsMsg = null;
    const msgStr = message.toString();

    try {
        // 1. 繼電器狀態同步 (smartplug/{plugId}/status)
        if (topic.endsWith('/status')) {
            const data = JSON.parse(msgStr);
            const relayId = data.relay_id !== undefined ? data.relay_id : data.id;
            const relayState = data.state;

            if (relayId !== undefined) {
                const state = getOrCreatePlugState(plugId);
                state.relays.set(relayId, {
                    ...(state.relays.get(relayId) || { name: `Relay ${relayId + 1}` }),
                    state: relayState
                });

                wsMsg = {
                    type: 'relay_response',
                    relay_id: relayId,
                    state: relayState
                };
            }
        }
        // 2. 繼電器名稱同步 (smartplug/{plugId}/relay/{id}/name)
        else if (topic.includes('/relay/') && topic.endsWith('/name')) {
            const relayId = parseInt(parts[3]);
            const state = getOrCreatePlugState(plugId);

            // 更新快取
            state.relays.set(relayId, {
                ...(state.relays.get(relayId) || { state: false }),
                name: msgStr
            });

            wsMsg = {
                type: 'relay_name_updated',
                relay_id: relayId,
                name: msgStr
            };
        }
        // 3. 電壓數據同步 (smartplug/{plugId}/voltage)
        else if (topic.endsWith('/voltage')) {
            let voltage = 0;
            try {
                const data = JSON.parse(msgStr);
                voltage = (data && data.voltage !== undefined) ? data.voltage : data;
            } catch (e) {
                // 非 JSON，嘗試從字串提取數字 (如 "220V")
                const match = msgStr.match(/(\d+(\.\d+)?)/);
                if (match) voltage = parseFloat(match[1]);
            }

            // 如果 voltage 是字串，再次嘗試提取數字
            if (typeof voltage === 'string') {
                const vMatch = voltage.match(/(\d+(\.\d+)?)/);
                if (vMatch) voltage = parseFloat(vMatch[1]);
                else voltage = 0;
            }

            wsMsg = {
                type: 'sensor_data',
                voltage: Number(voltage) || 0,
                temperature: (typeof currentTemperature !== 'undefined') ? currentTemperature : 0
            };
        }
        // 4. 插座名稱同步 (smartplug/{plugId}/plugName)
        else if (topic.endsWith('/plugName')) {
            const plugNameValue = (typeof msgStr === 'string' && msgStr.startsWith('{'))
                ? JSON.parse(msgStr).plugName
                : msgStr;

            wsMsg = {
                type: 'plug_name_updated',
                plugName: plugNameValue
            };
        }
    } catch (e) {
        console.warn(`⚠️ [Sync] 解析訊息失敗 (${topic}):`, e.message);
    }

    // 如果有生成結構化訊息，廣播給所有關注此 plugId 的客戶端
    if (wsMsg) {
        const targetClients = plugClients.get(plugId);
        if (targetClients) {
            const finalMsg = JSON.stringify(wsMsg);
            targetClients.forEach(cid => {
                const client = wsClients.get(cid);
                if (client && client.ws.readyState === 1) {
                    client.ws.send(finalMsg);
                }
            });
        }
    }

    // 溫度記錄處理
    if (topic.endsWith('/temperature')) {
        try {
            const payload = JSON.parse(msgStr);
            if (payload.temperature !== undefined) {
                currentTemperature = payload.temperature;
            }
        } catch (e) { }
    }
});

// ==========================================
// 處理 MQTT 收到的訊息 (ESP32 -> Server -> UI)
// ==========================================
mqttShared.on('message', (topic, message) => {
    try {
        const msgString = message.toString();
        const parts = topic.split('/');

        if (parts.length < 3 || parts[0] !== 'smartplug') return;

        const plugId = parts[1];
        const category = parts[2];
        const subCategory = parts[3];

        const payload = JSON.parse(msgString);
        let frontendData = null;

        if (category === 'temperature') {
            frontendData = {
                type: 'sensor_data',
                temperature: payload.temperature
            };
        }
        else if (category === 'voltage') {
            let voltageValue = 0;
            if (typeof payload === 'object' && payload !== null && payload.voltage !== undefined) {
                voltageValue = payload.voltage;
            } else {
                voltageValue = payload;
            }

            // 處理字串格式如 "220V"
            if (typeof voltageValue === 'string') {
                const match = voltageValue.match(/(\d+(\.\d+)?)/);
                if (match) voltageValue = parseFloat(match[1]);
                else voltageValue = 0;
            }

            frontendData = {
                type: 'sensor_data',
                voltage: Number(voltageValue) || 0
            };
        }
        else if (category === 'relay') {
            const state = getOrCreatePlugState(plugId);
            if (subCategory === 'state') {
                state.relays.set(payload.id, {
                    ...(state.relays.get(payload.id) || { name: `Relay ${payload.id + 1}` }),
                    state: payload.state === "1"
                });

                frontendData = {
                    type: 'relay_response',
                    relay_id: payload.id,
                    state: payload.state === "1"
                };
            } else if (subCategory === 'name') {
                state.relays.set(payload.id, {
                    ...(state.relays.get(payload.id) || { state: false }),
                    name: payload.name
                });

                frontendData = {
                    type: 'relay_name_updated',
                    relay_id: payload.id,
                    name: payload.name
                };
            }
        }
        else if (category === 'plugName') {
            frontendData = {
                type: 'plug_name_updated',
                plugName: payload.plugName
            };
        }

        if (frontendData) {
            broadcastToPlug(plugId, frontendData);
        }

    } catch (e) {
        // console.error(`解析 MQTT 訊息失敗 [${topic}]:`, e.message);
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
function handleWsMessage(message, ws, clientId, plugId) {
    try {
        const data = JSON.parse(message);
        const mqttClient = mqttShared.getClient(clientId);

        if (!mqttClient || !mqttClient.connected) {
            console.warn(`⚠️ [WS] [${clientId}] 跳過指令 ${data.command}，因為 MQTT 未連線`);
            ws.send(JSON.stringify({
                type: 'mqtt_status',
                connected: false,
                status: mqttShared.getStatus(clientId)
            }));
            return;
        }

        console.log(`📨 WS收到指令 [${plugId}][${clientId}]:`, data.command);

        switch (data.command) {
            case 'relay_control':
                // 優先使用 relay_id 或 relayIndex
                const rId = data.relay_id !== undefined ? data.relay_id : data.relayIndex;
                if (rId !== undefined) {
                    // 還原原始主題規範: smartplug/{plugId}/{clientId}/control
                    const topic = `smartplug/${plugId}/${clientId}/control`;
                    const payload = JSON.stringify({
                        id: rId,
                        state: data.state ? "1" : "0"
                    });
                    mqttClient.publish(topic, payload);
                    console.log(`📤 [WS] [${clientId}] Command: ${data.command} -> ${topic}`);
                }
                break;

            case 'rename_relay':
            case 'set_relay_name':
                const renId = data.relay_id !== undefined ? data.relay_id : data.relayIndex;
                if (renId !== undefined) {
                    // 還原原始主題規範: smartplug/{plugId}/{clientId}/name
                    const nameTopic = `smartplug/${plugId}/${clientId}/name`;
                    const namePayload = JSON.stringify({
                        id: renId,
                        name: data.name || data.newName
                    });
                    mqttClient.publish(nameTopic, namePayload);
                    console.log(`📤 [WS] [${clientId}] Command: ${data.command} -> ${nameTopic}`);
                }
                break;

            case 'get_sensors':
            case 'get_all_status':
                const reqTopic = `smartplug/${plugId}/get_status`;
                mqttClient.publish(reqTopic, 'all');

                // 相容舊版 sensor 數據請求
                const legacyReqTopic = `smartplug/${plugId}/${clientId}/request`;
                mqttClient.publish(legacyReqTopic, JSON.stringify({ type: "getPlugName" }));
                mqttClient.publish(legacyReqTopic, JSON.stringify({ type: "getVoltage" }));
                break;

            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    } catch (e) {
        console.error('❌ 處理 WS 訊息失敗:', e);
    }
}

// 初始化服務與 MQTT 自動重連
async function initializeServices() {
    try {
        console.log('🕒 正在初始化時間同步服務...');
        await initTimeSync();
        startPeriodicTimeSync(60);

        console.log('📝 正在初始化溫度記錄服務...');
        await initTemperatureLogger();

        // 啟動溫度記錄
        startTemperatureLogging(() => {
            return currentTemperature;
        }, 30);

        // ==========================================
        // MQTT 自動重連邏輯 (已移除，改由使用者手動觸發各別連線)
        // ==========================================
        console.log('ℹ️ [AutoReconnect] 已禁用全域自動重連，等待使用者手動連線');

        console.log('✅ 所有服務初始化完成');
    } catch (error) {
        console.error('❌ 服務初始化失敗:', error);
    }
}

let currentTemperature = 25.0;

// 在應用準備完成後初始化服務
app.prepare().then(async () => {
    // 監聽訊息改由 global_message 統一在上面處理

    await initializeServices();

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
            const url = new URL(request.url, `http://${request.headers.host}`);
            const clientId = url.searchParams.get('clientId') || `user_${Date.now()}`;
            const plugId = url.searchParams.get('plugId');

            if (!plugId) {
                ws.close(1008, 'PlugID Required');
                return;
            }

            console.log(`🔌 新連線: User=[${clientId}] -> Plug=[${plugId}]`);

            wsClients.set(clientId, { ws, plugId });
            if (!plugClients.has(plugId)) {
                plugClients.set(plugId, new Set());
            }
            plugClients.get(plugId).add(clientId);

            // 檢查該 Client 是否已有對應的 MQTT 連線
            const status = mqttShared.getStatus(clientId);
            const mqttClient = mqttShared.getClient(clientId);

            if (mqttClient && mqttClient.connected) {
                // 如果已連線，確保訂閱了該 plugId
                const topic = `smartplug/${plugId}/#`;
                mqttClient.subscribe(topic);

                ws.send(JSON.stringify({
                    type: 'mqtt_status',
                    connected: true,
                    status: 'connected'
                }));
            } else {
                ws.send(JSON.stringify({
                    type: 'mqtt_status',
                    connected: false,
                    status: status
                }));
            }

            // --- 新增：同步當前 Plug 狀態給新連線 ---
            const state = plugStates.get(plugId);
            if (state) {
                console.log(`📤 [Sync] 向新連線 [${clientId}] 推送 [${plugId}] 的現有狀態 (${state.relays.size} 個繼電器)`);
                state.relays.forEach((val, id) => {
                    ws.send(JSON.stringify({
                        type: 'relay_response',
                        relay_id: id,
                        state: val.state
                    }));
                    ws.send(JSON.stringify({
                        type: 'relay_name_updated',
                        relay_id: id,
                        name: val.name
                    }));
                });
            }

            // 如果是該 Plug 的首位關注者，或者為了保險起見，主動請求一次狀態
            if (mqttClient && mqttClient.connected) {
                const reqTopic = `smartplug/${plugId}/get_status`;
                mqttClient.publish(reqTopic, 'all');
            }

            ws.on('message', (message) => {
                handleWsMessage(message.toString(), ws, clientId, plugId);
            });

            ws.on('close', (code, reason) => {
                console.log(`👋 斷開連線: ${clientId}`);
                wsClients.delete(clientId);
                if (plugClients.has(plugId)) {
                    plugClients.get(plugId).delete(clientId);
                }
            });

            ws.on('error', (error) => {
                console.error(`❌ WebSocket 錯誤 [${clientId}]:`, error);
            });

        } catch (error) {
            console.error('❌ WebSocket 連接處理異常:', error);
            ws.close(1011, 'Internal Server Error');
        }
    });

    // 處理 Upgrade 請求
    server.on('upgrade', (request, socket, head) => {
        const { pathname } = parse(request.url);

        if (pathname === '/api/ws/operation') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (pathname.startsWith('/_next/')) {
            return;
        } else {
            socket.destroy();
        }
    });

    server.listen(port, hostname, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://${hostname}:${port}`);
    });
});