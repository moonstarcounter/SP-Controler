import mqtt, { MqttClient } from 'mqtt';
import { setMqttClient as setOperationMqttClient, setPlugId as setOperationPlugId } from './mqtt-operation';
import fs from 'fs/promises';
import path from 'path';

// 設定檔案路徑
const SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.json');
const PUBLIC_SETTINGS_PATH = path.join(process.cwd(), 'public', 'data', 'setting.json');

// 定義標準Topic
export const MqttTopics = {
  // 電壓數據: smartplug/{plugId}/voltage
  voltage: (plugId: string) => `smartplug/${plugId}/voltage`,
  // 設備名稱: smartplug/{plugId}/plugName
  plugName: (plugId: string) => `smartplug/${plugId}/plugName`,

  // 其他 Topic 定義
  temperature: (plugId: string) => `smartplug/${plugId}/temperature`,
  relayState: (plugId: string) => `smartplug/${plugId}/relay/state`,

  // announce 相關主題
  announce: (plugId: string) => `smartplug/${plugId}/announce`,
  announceResponse: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/announce`,

  // Client 控制主題
  control: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/control`,
  name: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/name`,
  plugNameTopic: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/plugName`,
  request: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/request`,

  // 離線通知主題
  offline: (plugId: string, identity: string) => `smartplug/${plugId}/${identity}/offline`,
};

// 廢除：不再自動更新設定檔案中的 clientId，保護伺服器端全域設定
export async function updateSettingsClientId(clientId: string): Promise<void> {
  console.log(`ℹ️ [Lib] 跳過更新設定檔案 clientId (保持全域設定不變): ${clientId}`);
  return;
}

// 讀取設定檔案獲取 plugId
async function getPlugIdFromSettings(): Promise<string> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(data);
    return settings.plugId || 'defaultPlug';
  } catch (error) {
    console.error('讀取設定檔案時發生錯誤:', error);
    return 'defaultPlug';
  }
}

// @ts-ignore
const mqttShared = require('./mqtt-shared');

// MQTT 用戶端實例 (狀態由 shared 管理)
let currentClientId: string = '';
let currentPlugId: string = 'defaultPlug';

// 內存快取數據 (供 API 讀取，區分 ClientID)
// 使用 global 確保在 Next.js HMR 重啟時資料不遺失且跨模組共享
interface ClientStateCache {
  plugName: string;
  voltage: number;
  isRegistered?: boolean; // 新增註冊狀態欄位
}
const CACHE_KEY = Symbol.for('smartplug.mqtt.clientCache');
if (!(global as any)[CACHE_KEY]) {
  (global as any)[CACHE_KEY] = new Map<string, ClientStateCache>();
}
const clientCache: Map<string, ClientStateCache> = (global as any)[CACHE_KEY];
const MAP_KEY = Symbol.for('smartplug.mqtt.sessionMap');
if (!(global as any)[MAP_KEY]) {
  (global as any)[MAP_KEY] = new Map<string, string>();
}
const clientIdToIdentityMap: Map<string, string> = (global as any)[MAP_KEY];

// 獲取 Identity 關聯的所有 Session ID
function getSessionsForIdentity(identity: string): string[] {
  const sessions: string[] = [];
  clientIdToIdentityMap.forEach((id, clientId) => {
    if (id === identity) sessions.push(clientId);
  });
  return sessions;
}

function getOrCreateCache(clientId: string): ClientStateCache {
  if (!clientCache.has(clientId)) {
    console.log(`🆕 [Lib] 為 ${clientId} 建立新的資料快取`);
    clientCache.set(clientId, { plugName: 'SmartPlug', voltage: 0, isRegistered: undefined });
  }
  return clientCache.get(clientId)!;
}

// 清除指定 clientId 的快取（登出時呼叫）
export function clearClientCache(clientId: string): void {
  if (clientCache.has(clientId)) {
    clientCache.delete(clientId);
    clientIdToIdentityMap.delete(clientId); // 同步移除映射
    console.log(`🧹 [Lib] 已清除 ${clientId} 的資料快取與映射`);
  }
}

// 清除所有 stale session ID 快取（保留 identity 快取）
export function clearSessionCaches(): void {
  const staleKeys: string[] = [];
  clientCache.forEach((_, key) => {
    // session ID 的格式為 smartplug_xxxxxxxx，而 identity 是使用者自定義的名稱
    if (key.startsWith('smartplug_') && key.length === 19) {
      staleKeys.push(key);
    }
  });
  staleKeys.forEach(k => {
    clientCache.delete(k);
    console.log(`🧹 [Lib] 已清除 stale session 快取: ${k}`);
  });
}

// MQTT 連線配置介面
interface MqttConfig {
  broker: string;
  port: string;
  clientId: string; // 技術連線 ID
  identity: string; // 邏輯身分 (身分變數)
  username?: string;
  password?: string;
}

/**
 * 客戶端初始化標記，確保訊息處理器只設置一次
 */
let isHandlerInited = false;

/**
 * 初始化共享 MQTT 訊息處理器
 * 在多使用者架構中，主要由 server.js 的 global_message 做廣播
 * 此處僅保留基礎的主題監聽，且從 Topic 解析出 identity 作為上下文
 */
function initSharedHandlers() {
  if (isHandlerInited) return;
  isHandlerInited = true;

  // 接收訊息時，根據 Topic 中的 identity 更新對應的快取
  mqttShared.on('message', (topic: string, message: Buffer, technicalClientId: string) => {
    try {
      const msgString = message.toString();

      // 從 Topic 提取 identity: smartplug/{plugId}/{identity}/{type}
      // 或者是 broadcast topic: smartplug/{plugId}/voltage
      const topicParts = topic.split('/');
      let identityFromTopic = '';
      if (topicParts.length >= 4) {
        identityFromTopic = topicParts[2];
      }

      // 1. 解析訊息內容（與 ID 無關）
      let voltage: number | undefined;
      let plugName: string | undefined;
      let isRegistered: boolean | undefined;

      // 電壓與名稱解析
      if (topic.endsWith('/voltage')) {
        try {
          const payload = JSON.parse(msgString);
          voltage = (payload && payload.voltage !== undefined) ? payload.voltage : payload;
        } catch (e) {
          const match = msgString.match(/(\d+(\.\d+)?)/);
          if (match) voltage = parseFloat(match[1]);
        }
      } else if (topic.endsWith('/plugName')) {
        try {
          const payload = JSON.parse(msgString);
          plugName = (payload && payload.plugName !== undefined) ? payload.plugName : payload;
        } catch (e) { plugName = msgString; }
      } else if (topic.includes('/announce')) {
        try {
          const payload = JSON.parse(msgString);
          if (payload.voltage !== undefined) voltage = Number(payload.voltage) || 0;
          if (payload.plugName !== undefined) plugName = payload.plugName;
          if (payload.registered !== undefined) isRegistered = !!payload.registered;
        } catch (e) { }
      }

      // 2. 定義更新函數
      const applyUpdates = (id: string) => {
        const cache = getOrCreateCache(id);
        if (voltage !== undefined) cache.voltage = voltage;
        if (plugName !== undefined) cache.plugName = plugName;
        if (isRegistered !== undefined) {
          cache.isRegistered = isRegistered;
          console.log(`🔑 [Lib] [${id}] 註冊狀態同步: ${isRegistered ? '已註冊' : '未註冊'}`);
        }
      };

      // 3. 執行同步廣播
      if (topicParts.length === 3) { // Broadcast
        clientCache.forEach((_, id) => applyUpdates(id));
      } else if (identityFromTopic) {
        // 更新身分快取
        applyUpdates(identityFromTopic);
        // 重要：同步更新所有與該身分關連的 Session 快取
        const sessions = getSessionsForIdentity(identityFromTopic);
        sessions.forEach(sid => {
          applyUpdates(sid);
          console.log(`🔄 [Lib] 同步數據至 Session: ${sid} (基於身分: ${identityFromTopic})`);
        });
      }

    } catch (e) {
      console.error('❌ [Lib] 訊息處理錯誤:', e);
    }
  });
}

// 預先啟動監聽器
initSharedHandlers();

// 連接到 MQTT Broker
export async function connectMqtt(config: MqttConfig): Promise<{ success: boolean; message: string }> {

  try {
    console.log('🔌 透過 SharedManager 請求連接 MQTT:', config.broker);

    // 獲取當前 PlugID 正確設置 will 與初始化
    currentPlugId = await getPlugIdFromSettings();
    currentClientId = config.clientId; // 此處為技術連線 ID

    // 將 config 傳給 sharedManager 執行連線
    const client = mqttShared.connect(config, 'Lib', currentPlugId);

    return new Promise((resolve) => {
      const onConnect = (connectedClientId: string) => {
        if (connectedClientId !== config.clientId) return;

        cleanup();
        console.log(`✅ MQTT 連線成功 (Lib: ${config.clientId}, Identity: ${config.identity})`);

        // 核心：建立映射關係
        clientIdToIdentityMap.set(config.clientId, config.identity);
        console.log(`🔗 [Map] 建立映射: ${config.clientId} -> ${config.identity}`);

        // 更新狀態
        setOperationPlugId(currentPlugId);
        setOperationMqttClient(client, config.clientId);

        // 訂閱基礎主題
        const vTopic = MqttTopics.voltage(currentPlugId);
        const nTopic = MqttTopics.plugName(currentPlugId);
        const announceResponseTopic = MqttTopics.announceResponse(currentPlugId, config.identity);

        client.subscribe([vTopic, nTopic, announceResponseTopic], { qos: 1 });
        console.log(`📡 [Lib] 已訂閱基礎資訊與回應主題 (Identity: ${config.identity})`);

        // 延遲發送初始化命令
        setTimeout(() => {
          if (client.connected) {
            const announceTopic = MqttTopics.announce(currentPlugId);
            const announcePayload = JSON.stringify({
              clientId: currentClientId, // 技術 ID (供相容性參考)
              identity: config.identity,  // 邏輯身分 (重要)
              plugId: currentPlugId,
              broker: config.broker,
              port: config.port,
              username: config.username || "",
              password: config.password || ""
            });
            client.publish(announceTopic, announcePayload, { qos: 1 });
            console.log(`📤 已發送 announce (Identity: ${config.identity})`);
          }
        }, 500);

        setTimeout(() => {
          if (client.connected) {
            const requestTopic = MqttTopics.request(currentPlugId, config.identity);
            const requestPayload = JSON.stringify({ type: "getVoltage" });
            client.publish(requestTopic, requestPayload, { qos: 1 });
            console.log(`📤 已發送電壓請求 (Identity: ${config.identity})`);
          }
        }, 1000);

        resolve({ success: true, message: 'MQTT 連線成功' });
      };

      const onError = (clientId: string, err: Error) => {
        if (clientId !== config.clientId) return;
        cleanup();
        resolve({ success: false, message: `連線失敗: ${err.message}` });
      };

      const cleanup = () => {
        mqttShared.removeListener('connect', onConnect);
        mqttShared.removeListener('error', onError);
      };

      mqttShared.on('connect', onConnect);
      mqttShared.on('error', onError);

      // 超時處理
      setTimeout(() => {
        cleanup();
        resolve({ success: false, message: '連線超時' });
      }, 12000);
    });

  } catch (error: any) {
    console.error('MQTT 連線異常:', error);
    return { success: false, message: error.message || '未知錯誤' };
  }
}

// 獲取 MQTT 連線狀態（包含註冊資訊）
export function getMqttStatus(clientId?: string): { connected: boolean; isRegistered?: boolean } {
  const idToCheck = clientId || currentClientId;
  if (!idToCheck) return { connected: false };

  const connected = mqttShared.getStatus(idToCheck) === 'connected';
  const cache = clientCache.get(idToCheck);

  return {
    connected,
    isRegistered: cache?.isRegistered
  };
}

// 獲取 MQTT 客戶端
export function getMqttClient(clientId?: string): any {
  const idToCheck = clientId || currentClientId;
  if (!idToCheck) return null;
  return mqttShared.getClient(idToCheck);
}

// 獲取插座名稱
export function getPlugName(clientId?: string): string {
  if (!clientId) return 'SmartPlug';
  const cache = getOrCreateCache(clientId);
  return cache.plugName;
}

// 獲取電壓
export function getVoltage(clientId?: string): number {
  if (!clientId) return 0;
  const cache = getOrCreateCache(clientId);
  console.log(`🔍 [Lib] [${clientId}] getVoltage 請求: ${cache.voltage}V`);
  return cache.voltage;
}

// 發布訊息
export function publishMqtt(topic: string, message: string, options?: any, clientId?: string): boolean {
  const client = clientId ? mqttShared.getClient(clientId) : null;
  if (!client || !client.connected) return false;
  client.publish(topic, message, { qos: options?.qos ?? 1, retain: options?.retain ?? false });
  return true;
}

// 獲取當前 Client ID
export function getClientId(): string {
  return currentClientId;
}

// 發送離線通知
export function sendOfflineNotification(clientId?: string): boolean {
  if (!clientId) return false;
  const client = mqttShared.getClient(clientId);
  if (!client || !client.connected) return false;

  try {
    const offlineTopic = MqttTopics.offline(currentPlugId, clientId);
    const offlinePayload = JSON.stringify({
      clientId: clientId,
      plugId: currentPlugId,
      reason: "manual_logout",
      timestamp: Date.now()
    });

    client.publish(offlineTopic, offlinePayload, { qos: 1 });
    return true;
  } catch (error) {
    return false;
  }
}

// 斷開 MQTT 連線
export function disconnectMqtt(clientId?: string): void {
  if (!clientId) return;
  sendOfflineNotification(clientId);
  mqttShared.disconnect(clientId);
}

// PlugID 驗證函數 (供其他模組使用)
export const validatePlugId = (id: string): string => {
  if (!id) return 'PlugID 不能為空';
  if (id.length < 8) return '至少需要8個字元';
  if (!/^[a-zA-Z0-9]+$/.test(id)) return '只能包含英文和數字';
  if (!/[a-zA-Z]/.test(id) || !/[0-9]/.test(id)) return '必須同時包含英文和數字';
  return '';
};
