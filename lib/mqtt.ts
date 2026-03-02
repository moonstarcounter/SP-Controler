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
  announceResponse: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/announce`,
  
  // Client 控制主題
  control: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/control`,
  name: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/name`,
  plugNameTopic: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/plugName`,
  request: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/request`,
};

// 更新設定檔案中的 clientId
async function updateSettingsClientId(clientId: string): Promise<void> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(data);
    settings.mqtt.clientId = clientId;
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8');
    await fs.writeFile(PUBLIC_SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8');
    console.log(`設定檔案已更新 clientId: ${clientId}`);
  } catch (error) {
    console.error('更新設定檔案時發生錯誤:', error);
  }
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

// MQTT 客戶端實例
let mqttClient: MqttClient | null = null;
let currentClientId: string = '';
let currentPlugId: string = 'defaultPlug';

// 內存快取數據 (供 API 讀取)
let plugNameData: string = 'SmartPlug';
let voltageData: number = 0;

// MQTT 連線配置介面
interface MqttConfig {
  broker: string;
  port: string;
  clientId: string;
  username?: string;
  password?: string;
}

// 連接到 MQTT Broker
export async function connectMqtt(config: MqttConfig): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      // 如果已經有連線，先斷開
      if (mqttClient && mqttClient.connected) {
        mqttClient.end();
      }

      const protocol = (config.port === '8083' || config.port === '8084') ? 'ws' : 'mqtt';
      const connectUrl = `${protocol}://${config.broker}:${config.port}/mqtt`;

      console.log('連接到 MQTT Broker:', connectUrl);

      mqttClient = mqtt.connect(connectUrl, {
        clientId: config.clientId,
        username: config.username || undefined,
        password: config.password || undefined,
        clean: true,
        reconnectPeriod: 30000, // 30秒自動重連
        connectTimeout: 10000,
        keepalive: 60,
      });

        // 連線成功處理
        mqttClient.on('connect', async () => {
            console.log('✅ MQTT 連線成功');
            currentClientId = config.clientId;

            // 更新設定檔案中的 clientId
            updateSettingsClientId(config.clientId);

            // 讀取並設置 PlugID
            try {
                currentPlugId = await getPlugIdFromSettings();
                console.log(`使用 PlugID: ${currentPlugId}`);

                // 更新 Operation 模組的 PlugID
                setOperationPlugId(currentPlugId);

                // 立即訂閱電壓與名稱 Topic (QoS 1)
                if (mqttClient) {
                    const vTopic = MqttTopics.voltage(currentPlugId);
                    const nTopic = MqttTopics.plugName(currentPlugId);
                    const announceResponseTopic = MqttTopics.announceResponse(currentPlugId, currentClientId);

                    mqttClient.subscribe(vTopic, { qos: 1 });
                    mqttClient.subscribe(nTopic, { qos: 1 });
                    mqttClient.subscribe(announceResponseTopic, { qos: 1 });

                    console.log(`📡 [Lib] 已訂閱基礎資訊 Topic: ${currentPlugId}`);
                    console.log(`📡 [Lib] 已訂閱 announce 回應主題: ${announceResponseTopic}`);
                }

            } catch (error) {
                console.error('讀取 PlugID 失敗:', error);
                currentPlugId = 'defaultPlug';
                setOperationPlugId(currentPlugId);
            }

            // 設置操作面板的 MQTT 客戶端
            if (mqttClient) {
                setOperationMqttClient(mqttClient, currentClientId);
            }

            // 延遲發送請求序列
            if (mqttClient) {
                // 延遲 1.0 秒：發送 getVoltage 請求
                setTimeout(() => {
                    if (mqttClient && mqttClient.connected) {
                        const requestTopic = MqttTopics.request(currentPlugId, currentClientId);
                        const requestPayload = JSON.stringify({ type: "getVoltage" });
                        mqttClient.publish(requestTopic, requestPayload, { qos: 1 });
                        console.log(`📤 延遲 1.0 秒: 已發送電壓請求到: ${requestTopic}`);
                    }
                }, 1000);

                // 延遲 1.5 秒：發布 announce { clientId: "xxx" }
                setTimeout(() => {
                    if (mqttClient && mqttClient.connected) {
                        const announceTopic = MqttTopics.announce(currentPlugId);
                        const announcePayload = JSON.stringify({ 
                            clientId: currentClientId,
                            plugId: currentPlugId
                        });
                        mqttClient.publish(announceTopic, announcePayload, { qos: 1 });
                        console.log(`📤 延遲 1.5 秒: 已發送 announce 到: ${announceTopic}`);
                        console.log(`📤 Announce 內容: ${announcePayload}`);
                    }
                }, 1500);
            }

            resolve({ success: true, message: 'MQTT 連線成功' });
        });

      // 連線錯誤處理
      mqttClient.on('error', (error) => {
        console.error('❌ MQTT 連線錯誤:', error);
        resolve({ success: false, message: `連線錯誤: ${error.message}` });
      });

      // 斷線處理 - 顯示日誌
      mqttClient.on('close', () => {
        console.warn('⚠️ MQTT 連線已斷開');
      });

      // 斷線處理 - 顯示日誌
      mqttClient.on('offline', () => {
        console.warn('⚠️ MQTT 離線');
      });

      // 重新連接處理
      mqttClient.on('reconnect', () => {
        console.log('🔄 MQTT 正在重新連接...');
      });

      // 接收訊息並更新內存變數
      mqttClient.on('message', (topic, message) => {
        const msgStr = message.toString();
        // console.log(`📨 Lib 收到 [${topic}]:`, msgStr); 

        try {
          const jsonData = JSON.parse(msgStr);

          // 更新電壓快取
          if (topic === MqttTopics.voltage(currentPlugId)) {
            // 兼容 {"voltage": 110} 或 直接傳數字/字串
            voltageData = jsonData.voltage !== undefined ? jsonData.voltage : jsonData;
            // console.log(`⚡ 電壓數據已更新: ${voltageData}V`);
          }
          // 更新名稱快取
          else if (topic === MqttTopics.plugName(currentPlugId)) {
            plugNameData = jsonData.plugName || jsonData || 'SmartPlug';
          }

        } catch (e) {
          console.error('解析 MQTT 訊息失敗:', e);
        }
      });

      // 連線超時處理
      setTimeout(() => {
        if (!mqttClient?.connected) {
          resolve({ success: false, message: '連線超時' });
        }
      }, 12000);

    } catch (error: any) {
      console.error('MQTT 連線異常:', error);
      resolve({ success: false, message: error.message || '未知錯誤' });
    }
  });
}

// 獲取 MQTT 連線狀態
export function getMqttStatus(): boolean {
  return mqttClient?.connected || false;
}

// 獲取 MQTT 客戶端
export function getMqttClient(): MqttClient | null {
  return mqttClient;
}

// 獲取插座名稱 (API Route 會呼叫此函數)
export function getPlugName(): string {
  return plugNameData;
}

// 獲取電壓 (API Route 會呼叫此函數)
export function getVoltage(): number {
  return voltageData;
}

// 發布訊息到 MQTT
export function publishMqtt(topic: string, message: string, options?: { qos?: 0 | 1 | 2, retain?: boolean }): boolean {
  if (!mqttClient || !mqttClient.connected) {
    return false;
  }
  const qos = options?.qos ?? 1;
  mqttClient.publish(topic, message, { qos });
  return true;
}

// 獲取當前 Client ID
export function getClientId(): string {
  return currentClientId;
}

// 斷開 MQTT 連線
export function disconnectMqtt(): void {
  if (mqttClient) {
    mqttClient.end();
    mqttClient = null;
  }
}

// PlugID 驗證函數 (供其他模組使用)
export const validatePlugId = (id: string): string => {
  if (!id) return 'PlugID 不能為空';
  if (id.length < 8) return '至少需要8個字元';
  if (!/^[a-zA-Z0-9]+$/.test(id)) return '只能包含英文和數字';
  if (!/[a-zA-Z]/.test(id) || !/[0-9]/.test(id)) return '必須同時包含英文和數字';
  return '';
};
