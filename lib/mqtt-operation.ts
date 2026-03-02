import mqtt, { MqttClient } from 'mqtt';

// MQTT 客戶端實例
let mqttClient: MqttClient | null = null;
let currentClientId: string = '';

// 儲存感測器數據（每個客戶端獨立）
interface RelayData {
  id: number;
  name: string;
  state: boolean;
}

interface SensorData {
  temperature: number;
  relays: RelayData[];
}

// 每個客戶端的數據，使用 Map 存儲
const clientDataMap = new Map<string, SensorData>();

// WebSocket 類型定義（兼容 Node.js ws 和瀏覽器 WebSocket）
interface CustomWebSocket {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

// WebSocket 客戶端管理（每個客戶端獨立）
const wsClientMap = new Map<string, Set<CustomWebSocket>>();

// PlugID 類型（由使用者設定的設備識別碼）
type PlugId = string;

// 儲存當前 PlugID（從設定檔讀取）
let currentPlugId: PlugId = '';

// MQTT 主題定義
const MQTT_TOPICS = {
  // 主題模板函數
  // 控制類主題 (Client → ESP32)
  CONTROL: (plugId: PlugId, clientId: string) => `smartplug/${plugId}/${clientId}/control`,
  NAME: (plugId: PlugId, clientId: string) => `smartplug/${plugId}/${clientId}/name`,
  PLUG_NAME_SET: (plugId: PlugId, clientId: string) => `smartplug/${plugId}/${clientId}/plugName`,
  VOLTAGE_SET: (plugId: PlugId, clientId: string) => `smartplug/${plugId}/${clientId}/voltage`,
  REQUEST: (plugId: PlugId, clientId: string) => `smartplug/${plugId}/${clientId}/request`,

  // 廣播類主題 (ESP32 → All Clients)
  RELAY_STATE: (plugId: PlugId) => `smartplug/${plugId}/relay/state`,
  RELAY_NAME: (plugId: PlugId) => `smartplug/${plugId}/relay/name`,
  TEMPERATURE: (plugId: PlugId) => `smartplug/${plugId}/temperature`,
  VOLTAGE: (plugId: PlugId) => `smartplug/${plugId}/voltage`,
  PLUG_NAME: (plugId: PlugId) => `smartplug/${plugId}/plugName`,
};

// 獲取或初始化客戶端數據
function getOrCreateClientData(clientId: string): SensorData {
  if (!clientDataMap.has(clientId)) {
    clientDataMap.set(clientId, {
      temperature: 0,
      relays: Array.from({ length: 6 }, (_, i) => ({
        id: i,
        name: `Relay ${i + 1}`,
        state: false
      }))
    });
  }
  return clientDataMap.get(clientId)!;
}

// 獲取 MQTT 客戶端
export function getMqttClient(): MqttClient | null {
  return mqttClient;
}

// 獲取當前 Client ID
export function getCurrentClientId(): string {
  return currentClientId;
}

// 設置 PlugID（由前端傳入）
export function setPlugId(plugId: string) {
  currentPlugId = plugId;
  console.log(`✅ PlugID 已設置為: ${currentPlugId}`);
}

// 設置 MQTT 客戶端（從登入頁面連線後）
export function setMqttClient(client: MqttClient, clientId: string) {
  mqttClient = client;
  currentClientId = clientId;
  subscribeMqttTopics(clientId);
}

// 訂閱 MQTT 主題
function subscribeMqttTopics(clientId: string) {
  if (!mqttClient || !mqttClient.connected) {
    console.warn('MQTT 未連線，無法訂閱主題');
    return;
  }

  // 讀取設定檔獲取 PlugID
  // 注意：這裡假設設定檔已經被前端更新，這裡需要讀取最新的設定檔
  // 為了簡單起見，我們暫時從設定檔讀取，但更好的方式是由前端傳遞
  // 由於 fs 模組可能不可用，這裡先使用預設值，後續由 setPlugId 函數設置
  if (!currentPlugId) {
    console.warn('⚠️ PlugID 未設置，將使用預設值 "defaultPlug"');
    currentPlugId = 'defaultPlug';
  }

  // 訂閱操作相關廣播主題（QoS 1）
  // 注意：電壓(voltage)和設備名稱(plugName)由 mqtt.ts 訂閱 (QoS 0)
  // 這裡只訂閱操作面板需要的實時數據
  const operationTopics = [
    MQTT_TOPICS.RELAY_STATE(currentPlugId),
    MQTT_TOPICS.RELAY_NAME(currentPlugId),
    MQTT_TOPICS.TEMPERATURE(currentPlugId),
  ];

  operationTopics.forEach(topic => {
    mqttClient?.subscribe(topic, { qos: 1 }, (err) => {
      if (!err) {
        console.log(`📩 已訂閱操作主題 [QoS 1]: ${topic}`);
      } else {
        console.error(`訂閱失敗: ${topic}`, err);
      }
    });
  });

  // 設置訊息處理（只處理操作相關主題）
  // 注意：mqtt.ts 已經設置了全域的 message 處理器，這裡需要確保不衝突
  // 我們使用獨立的事件監聽器來處理操作相關訊息
  mqttClient.on('message', handleMqttMessage);

  // 請求初始數據（使用新版請求主題）
  const requestTopic = MQTT_TOPICS.REQUEST(currentPlugId, clientId);
  publishMqtt(requestTopic, JSON.stringify({ 
    type: 'request_all',
    timestamp: Date.now()
  }), { qos: 1 });
}

// 處理 MQTT 訊息
function handleMqttMessage(topic: string, message: Buffer) {
  const data = message.toString();

  // 嘗試解析 JSON，如果失敗則視為純文字
  let parsedData: any;
  try {
    parsedData = JSON.parse(data);
  } catch (e) {
    parsedData = data;
  }

  // 只處理操作相關的主題，避免與 mqtt.ts 衝突
  // mqtt.ts 負責處理電壓(voltage)和設備名稱(plugName)
  if (topic === MQTT_TOPICS.RELAY_STATE(currentPlugId)) {
    handleBroadcastRelayState(parsedData);
  } else if (topic === MQTT_TOPICS.RELAY_NAME(currentPlugId)) {
    handleBroadcastRelayName(parsedData);
  } else if (topic === MQTT_TOPICS.TEMPERATURE(currentPlugId)) {
    // 廣播溫度主題
    handleBroadcastTemperature(parsedData);
  }
  // 電壓和設備名稱由 mqtt.ts 處理，這裡忽略
}

// 處理廣播繼電器狀態
function handleBroadcastRelayState(data: any) {
  let relayData = data;
  if (typeof relayData === 'string') {
    try {
      relayData = JSON.parse(relayData);
    } catch (e) {
      console.error('RELAY_STATE 訊息格式錯誤');
      return;
    }
  }

  if (relayData.id !== undefined && relayData.state !== undefined) {
    // 兼容字符串 "1"/"0" 或布林值
    let stateBool: boolean;
    if (typeof relayData.state === 'string') {
      stateBool = relayData.state === '1';
    } else {
      stateBool = Boolean(relayData.state);
    }

    // 更新所有客戶端的數據
    clientDataMap.forEach((sensorData, clientId) => {
      if (sensorData.relays[relayData.id]) {
        sensorData.relays[relayData.id].state = stateBool;
        // 廣播給該客戶端的所有 WebSocket 連接
        broadcastToClient(clientId, {
          type: 'relay_response',
          relay_id: relayData.id,
          state: stateBool,
          success: true
        });
      }
    });
  }
}

// 處理廣播繼電器名稱
function handleBroadcastRelayName(data: any) {
  let nameData = data;
  if (typeof nameData === 'string') {
    try {
      nameData = JSON.parse(nameData);
    } catch (e) {
      console.error('RELAY_NAME 訊息格式錯誤');
      return;
    }
  }

  if (nameData.id !== undefined && nameData.name !== undefined) {
    // 更新所有客戶端的數據
    clientDataMap.forEach((sensorData, clientId) => {
      if (sensorData.relays[nameData.id]) {
        sensorData.relays[nameData.id].name = nameData.name;
        // 廣播給該客戶端的所有 WebSocket 連接
        broadcastToClient(clientId, {
          type: 'relay_name_updated',
          relay_id: nameData.id,
          name: nameData.name
        });
      }
    });
  }
}

// 處理廣播溫度
function handleBroadcastTemperature(data: any) {
  let temperatureValue = 0;

  if (typeof data === 'number') {
    temperatureValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    temperatureValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.temperature !== undefined) {
    temperatureValue = data.temperature;
  }

  // 更新所有客戶端的溫度數據
  clientDataMap.forEach((sensorData, clientId) => {
    sensorData.temperature = temperatureValue;

    // 廣播給該客戶端的所有 WebSocket 連接
    broadcastToClient(clientId, {
      type: 'sensor_data',
      temperature: sensorData.temperature,
      relays: sensorData.relays
    });
  });

  console.log(`📢 廣播溫度更新: ${temperatureValue}°C`);
}

// 處理廣播電壓
function handleBroadcastVoltage(data: any) {
  let voltageValue = 0;

  if (typeof data === 'number') {
    voltageValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    voltageValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.voltage !== undefined) {
    voltageValue = data.voltage;
  }

  // 更新所有客戶端的電壓數據
  clientDataMap.forEach((sensorData, clientId) => {
    // 更新電壓數據（如果需要可以儲存）
    // 目前僅記錄，未來可擴展
    console.log(`📢 廣播電壓更新: ${voltageValue}V (客戶端 ${clientId})`);
  });

  console.log(`📢 廣播電壓更新: ${voltageValue}V`);
}

// 處理廣播設備名稱
function handleBroadcastPlugName(data: any) {
  let plugName = '';

  if (typeof data === 'string') {
    plugName = data;
  } else if (data && typeof data === 'object' && data.plugName !== undefined) {
    plugName = data.plugName;
  }

  // 更新所有客戶端的設備名稱數據
  clientDataMap.forEach((sensorData, clientId) => {
    // 更新設備名稱數據（如果需要可以儲存）
    // 目前僅記錄，未來可擴展
    console.log(`📢 廣播設備名稱更新: ${plugName} (客戶端 ${clientId})`);
  });

  console.log(`📢 廣播設備名稱更新: ${plugName}`);
}

// 處理個別客戶端插座名稱
function handleClientPlugName(clientId: string, data: any) {
  let plugName = '';

  if (typeof data === 'string') {
    plugName = data;
  } else if (data && typeof data === 'object' && data.plugName !== undefined) {
    plugName = data.plugName;
  }

  if (plugName) {
    console.log(`更新客戶端 ${clientId} 插座名稱: ${plugName}`);
    // 這裡可以存儲到客戶端特定的數據中，如果需要
    // 目前僅記錄，未來可擴展儲存
  }
}

// 處理個別客戶端電壓
function handleClientVoltage(clientId: string, data: any) {
  let voltageValue = 0;

  if (typeof data === 'number') {
    voltageValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    voltageValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.voltage !== undefined) {
    voltageValue = data.voltage;
  }

  if (voltageValue > 0) {
    console.log(`更新客戶端 ${clientId} 電壓: ${voltageValue}V`);
    // 這裡可以存儲到客戶端特定的數據中，如果需要
    // 目前僅記錄，未來可擴展儲存
  }
}

// 發布 MQTT 訊息（預設 QoS 1）
export function publishMqtt(topic: string, message: string, options?: { qos?: 0 | 1 | 2, retain?: boolean }): boolean {
  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT 未連線');
    return false;
  }
  const qos = options?.qos ?? 1;
  mqttClient.publish(topic, message, { qos });
  console.log(`📤 已發布 [QoS: ${qos}] [${topic}]:`, message);
  return true;
}

// 控制繼電器（發送到指定 PlugID 的控制主題）
export function controlRelay(relayId: number, state: boolean, plugId: PlugId = currentPlugId): boolean {
  console.log(`🔧 controlRelay 被呼叫: relayId=${relayId}, state=${state}, plugId=${plugId}, currentClientId=${currentClientId}`);
  const message = JSON.stringify({
    id: relayId,
    state: state ? "1" : "0"
  });
  const topic = MQTT_TOPICS.CONTROL(plugId, currentClientId);
  console.log(`📤 準備發送到主題: ${topic}, 訊息: ${message}`);
  const result = publishMqtt(topic, message, { qos: 1 });
  console.log(`📤 發送結果: ${result ? '成功' : '失敗'}`);
  return result;
}

// 更新繼電器名稱（發送到指定 PlugID 的名稱主題）
export function updateRelayName(relayId: number, name: string, plugId: PlugId = currentPlugId): boolean {
  const message = JSON.stringify({
    id: relayId,
    name: name
  });
  const topic = MQTT_TOPICS.NAME(plugId, currentClientId);
  return publishMqtt(topic, message, { qos: 1 });
}

// 獲取當前客戶端的感測器數據
export function getSensorData(): SensorData {
  return getOrCreateClientData(currentClientId);
}

// WebSocket 客戶端管理
export function addWsClient(client: CustomWebSocket, clientId: string) {
  if (!wsClientMap.has(clientId)) {
    wsClientMap.set(clientId, new Set());
  }
  wsClientMap.get(clientId)!.add(client);

  console.log(`✅ 客戶端 ${clientId} 已添加到 WebSocket 管理`);

  // 不發送任何初始數據，等待客戶端請求
  // 這樣可以避免因發送數據而導致連接立即關閉的問題
}

export function removeWsClient(client: CustomWebSocket, clientId: string) {
  if (wsClientMap.has(clientId)) {
    const clientSet = wsClientMap.get(clientId)!;
    clientSet.delete(client);
    if (clientSet.size === 0) {
      wsClientMap.delete(clientId);
    }
  }
}

// 廣播給特定客戶端的所有 WebSocket 連接
function broadcastToClient(clientId: string, data: any) {
  if (!wsClientMap.has(clientId)) {
    return;
  }

  const message = JSON.stringify(data);
  const clientSet = wsClientMap.get(clientId)!;

  clientSet.forEach(client => {
    try {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    } catch (e) {
      console.error('廣播失敗:', e);
    }
  });
}

// 處理 WebSocket 訊息
export function handleWsMessage(message: string, client: CustomWebSocket, clientId: string) {
  try {
    const data = JSON.parse(message);
    console.log('📨 收到 WS 命令:', data);

    switch (data.command) {
      case 'get_sensors':
        // 回應當前感測器數據
        const sensorData = getOrCreateClientData(clientId);
        client.send(JSON.stringify({
          type: 'sensor_data',
          temperature: sensorData.temperature,
          relays: sensorData.relays
        }));
        console.log('✅ 回應 get_sensors 命令');
        break;

      case 'relay_control':
        const { relay_id, state } = data;
        if (relay_id !== undefined && state !== undefined) {
          // 暫時使用當前客戶端 ID 發送控制命令
          // 注意：這裡應該使用客戶端特定的控制主題
          controlRelay(relay_id, state);
        }
        break;

      case 'ping':
        // 回應 pong 以維持連接
        client.send(JSON.stringify({
          type: 'pong',
          timestamp: Date.now()
        }));
        console.log('✅ 回應 ping 命令');
        break;

      default:
        client.send(JSON.stringify({
          type: 'error',
          message: `未知命令: ${data.command}`
        }));
        console.log('收到未知命令:', data.command);
    }
  } catch (e) {
    console.error('處理 WS 訊息失敗:', e);
    try {
      client.send(JSON.stringify({
        type: 'error',
        message: '訊息格式無效'
      }));
    } catch (sendError) {
      console.error('發送錯誤訊息失敗:', sendError);
    }
  }
}

// 設置 MQTT 訊息回調（用於外部處理）
export function onMqttMessage(callback: (topic: string, message: string) => void) {
  if (mqttClient) {
    mqttClient.on('message', (topic, message) => {
      callback(topic, message.toString());
    });
  }
}
