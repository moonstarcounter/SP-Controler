'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();

  // PlugID 狀態
  const [plugId, setPlugId] = useState('');
  const [plugIdError, setPlugIdError] = useState('');

  // MQTT 連線狀態
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [mqttConfig, setMqttConfig] = useState({
    broker: 'broker.emqx.io',
    port: '8083',
    clientId: '', // 初始化為空，等待 useEffect 生成
    username: '',
    password: ''
  });

  // 設定檔案
  const [settings, setSettings] = useState<{
    mqtt: { broker: string; port: string; clientId: string; username: string; password: string };
    plugName: string;
    loginPassword: string;
    plugId?: string;
  } | null>(null);

// 插座資訊
const [plugName, setPlugName] = useState('SmartPlug');
const [voltage, setVoltage] = useState<string>('-- V'); // 初始顯示
const [voltageLoading, setVoltageLoading] = useState(false);

// ESP32 回應狀態
const [esp32Status, setEsp32Status] = useState<'waiting' | 'responding' | 'timeout' | 'success' | 'error'>('waiting');

// 登入狀態
const [loginPassword, setLoginPassword] = useState('');
const [errorMessage, setErrorMessage] = useState('');
const [loginLoading, setLoginLoading] = useState(false);

  // MQTT 配置顯示切換
  const [showMqttConfig, setShowMqttConfig] = useState(true);

  // PlugID 驗證函數
  const validatePlugId = (id: string): string => {
    if (id.length < 8) return '至少需要8個字元';
    if (!/^[a-zA-Z0-9]+$/.test(id)) return '只能包含英文和數字，不允許中文及符號字元';
    if (!/[a-zA-Z]/.test(id) || !/[0-9]/.test(id)) return '必須同時包含英文和數字';
    return '';
  };

  // 處理 PlugID 變更
  const handlePlugIdChange = (value: string) => {
    setPlugId(value);
    const error = validatePlugId(value);
    setPlugIdError(error);
  };

  // 讀取設定檔案
  useEffect(() => {
    // 產生隨機 ClientID
    const randomId = `smartplug_${Math.random().toString(16).slice(2, 10)}`;

    const loadSettings = async () => {
      try {
        const response = await fetch('/data/setting.json');
        if (!response.ok) {
          throw new Error('無法讀取設定檔案');
        }
        const data = await response.json();
        setSettings(data);

        // 更新 MQTT 配置初始值
        setMqttConfig({
          broker: data.mqtt?.broker || 'broker.emqx.io',
          port: data.mqtt?.port || '8083',
          clientId: data.mqtt?.clientId === 'smartplug_random' ? randomId : (data.mqtt?.clientId || randomId),
          username: data.mqtt?.username || '',
          password: data.mqtt?.password || ''
        });

        // 更新插座名稱初始值
        if (data.plugName) setPlugName(data.plugName);

        // 如果有保存的 plugId，則載入
        if (data.plugId) {
          setPlugId(data.plugId);
          const error = validatePlugId(data.plugId);
          if (error) {
            setPlugIdError(`已保存的 PlugID 不符合規則: ${error}`);
          }
        }
      } catch (error) {
        console.error('讀取設定檔案時發生錯誤:', error);
        // 錯誤時至少設定 ClientID
        setMqttConfig(prev => ({ ...prev, clientId: randomId }));
      }
    };

    loadSettings();
  }, []);

  // 獲取插座名稱 (API)
  const fetchPlugName = async () => {
    try {
      const response = await fetch('/api/plugName');
      const data = await response.json();
      if (data.plugName && data.plugName.trim() !== '') {
        setPlugName(data.plugName);
      }
    } catch (error) {
      console.error('獲取插座名稱時發生錯誤:', error);
    }
  };

  // 獲取電壓 (API)
  const fetchVoltage = async () => {
    setVoltageLoading(true);
    try {
      const response = await fetch('/api/voltage');
      const data = await response.json();

      // 根據回傳值判斷顯示
      if (data.voltage !== undefined && data.voltage !== 0) {
        setVoltage(`AC-${data.voltage}V`);
      } else {
        setVoltage('AC-0V (無數據)');
      }
    } catch (error) {
      console.error('獲取電壓時發生錯誤:', error);
      setVoltage('無法載入電壓');
    } finally {
      setVoltageLoading(false);
    }
  };

  // 儲存 PlugID 和 MQTT 設定到設定檔案 (API)
  const savePlugIdToSettings = async (id: string, mqttConfig: any) => {
    try {
      // 讀取當前設定檔案，確保獲取完整的設定結構
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error('無法讀取設定檔案');
      const currentSettings = await response.json();
      
      // 更新 plugId 和 MQTT 設定，保留所有其他設定
      const newSettings = {
        ...currentSettings,
        plugId: id,
        mqtt: {
          ...currentSettings.mqtt,
          broker: mqttConfig.broker,
          port: mqttConfig.port,
          clientId: mqttConfig.clientId,
          username: mqttConfig.username || '',
          password: mqttConfig.password || ''
        }
      };

      const saveResponse = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });

      const result = await saveResponse.json();
      if (!saveResponse.ok || !result.success) {
        throw new Error(result.error || '儲存設定失敗');
      }

      console.log('PlugID 和 MQTT 設定已儲存到設定檔案:', {
        plugId: id,
        clientId: mqttConfig.clientId
      });
      return true;
    } catch (error) {
      console.error('儲存 PlugID 和 MQTT 設定時發生錯誤:', error);
      return false;
    }
  };

  // 連接 MQTT
  const connectMqtt = async () => {
    // 檢查 PlugID 是否有效
    if (!plugId || plugIdError) {
      alert('請輸入有效的 PlugID');
      return;
    }

    if (!mqttConfig.broker || !mqttConfig.port || !mqttConfig.clientId) {
      alert('請填寫完整的 MQTT 連線資訊');
      return;
    }

    // 先儲存 PlugID 和 MQTT 設定到設定檔案
    const saved = await savePlugIdToSettings(plugId, mqttConfig);
    if (!saved) {
      alert('儲存 PlugID 失敗，請稍後再試');
      return;
    }

    setMqttStatus('connecting');
    setVoltage('偵測中...');

    try {
      // 呼叫後端 API 建立 MQTT 連線
      const response = await fetch('/api/mqtt/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mqttConfig)
      });

      const data = await response.json();

      if (data.success) {
        setMqttStatus('connected');
        setShowMqttConfig(false);

        // 保存連線資訊到 sessionStorage，供操作頁面使用
        try {
          sessionStorage.setItem('mqttClientId', mqttConfig.clientId);
          sessionStorage.setItem('plugId', plugId);
          console.log('連線資訊已保存到 sessionStorage');
        } catch (e) {
          console.error('保存 sessionStorage 失敗:', e);
        }

        // 獲取靜態名稱
        fetchPlugName();

        // 關鍵：延遲 1.5 秒後呼叫 API 獲取電壓
        // 這是為了等待 MQTT Broker 發送 Retain 訊息，或等待訂閱生效
        setTimeout(() => {
          fetchVoltage();
        }, 1500);

      } else {
        setMqttStatus('disconnected');
        alert('MQTT 連線失敗: ' + data.message);
      }
    } catch (error) {
      setMqttStatus('disconnected');
      setVoltage('-- V');
      console.error('MQTT 連線錯誤:', error);
      alert('MQTT 連線失敗，請檢查網路設定');
    }
  };

  // 登入處理
  const handleLogin = async () => {
    if (!loginPassword) {
      setErrorMessage('請輸入密碼');
      return;
    }

    // 再次確保 Session 正確 (雙重保險)
    if (plugId) sessionStorage.setItem('plugId', plugId);
    if (mqttConfig.clientId) sessionStorage.setItem('mqttClientId', mqttConfig.clientId);

    setErrorMessage('');
    setLoginLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword })
      });

      if (response.ok) {
        console.log('登入成功，載入操作面板...');
        router.push('/operation');
      } else {
        const data = await response.json();
        setErrorMessage(data.message || '登入失敗，請檢查密碼。');
      }
    } catch (error) {
      console.error('登入錯誤:', error);
      setErrorMessage('登入失敗，請稍後再試。');
    } finally {
      setLoginLoading(false);
    }
  };

  // Enter 鍵登入
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && mqttStatus === 'connected' && !loginLoading) {
      handleLogin();
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-5">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-gray-800 text-center mb-6">
          智能家居遠控系統
        </h1>

        {/* PlugID 輸入區 */}
        <div className="mb-6">
          <label className="block text-gray-700 font-medium mb-2">
            PlugID (用於區分不同 ESP32 設備)
          </label>
          <input
            type="text"
            value={plugId}
            onChange={(e) => handlePlugIdChange(e.target.value)}
            placeholder="至少8個字，限英文+數字之組合"
            className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
            disabled={mqttStatus === 'connecting' || mqttStatus === 'connected'}
          />
          {plugIdError && (
            <div className="text-red-600 text-sm mt-2">{plugIdError}</div>
          )}
          {!plugIdError && plugId && mqttStatus === 'disconnected' && (
            <div className="text-green-600 text-sm mt-2">✓ PlugID 格式正確</div>
          )}
        </div>

        {/* MQTT 連線配置區 */}
        {showMqttConfig && (
          <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-blue-900">MQTT 連線設定</h2>
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${mqttStatus === 'connected' ? 'bg-green-500 text-white' :
                mqttStatus === 'connecting' ? 'bg-yellow-500 text-white' :
                  'bg-gray-500 text-white'
                }`}>
                {mqttStatus === 'connected' ? '已連線' :
                  mqttStatus === 'connecting' ? '連線中...' :
                    '未連線'}
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  伺服器位址 *
                </label>
                <input
                  type="text"
                  value={mqttConfig.broker}
                  onChange={(e) => setMqttConfig({ ...mqttConfig, broker: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder={settings ? settings.mqtt.broker : "broker.emqx.io"}
                  disabled={mqttStatus === 'connecting'}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    連線埠號 *
                  </label>
                  <input
                    type="text"
                    value={mqttConfig.port}
                    onChange={(e) => setMqttConfig({ ...mqttConfig, port: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    placeholder={settings ? settings.mqtt.port : "8083"}
                    disabled={mqttStatus === 'connecting'}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client ID *
                  </label>
                  <input
                    type="text"
                    value={mqttConfig.clientId}
                    onChange={(e) => setMqttConfig({ ...mqttConfig, clientId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                    placeholder={settings ? settings.mqtt.clientId : "client_id"}
                    disabled={mqttStatus === 'connecting'}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  使用者名稱
                </label>
                <input
                  type="text"
                  value={mqttConfig.username}
                  onChange={(e) => setMqttConfig({ ...mqttConfig, username: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder={settings ? (settings.mqtt.username || "選填") : "選填"}
                  disabled={mqttStatus === 'connecting'}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  連線密碼
                </label>
                <input
                  type="password"
                  value={mqttConfig.password}
                  onChange={(e) => setMqttConfig({ ...mqttConfig, password: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                  placeholder={settings ? (settings.mqtt.password ? "******" : "選填") : "選填"}
                  disabled={mqttStatus === 'connecting'}
                />
              </div>

              <button
                onClick={connectMqtt}
                disabled={mqttStatus === 'connecting' || mqttStatus === 'connected'}
                className={`w-full py-3 rounded-lg font-medium transition-opacity ${mqttStatus === 'connected'
                  ? 'bg-green-500 text-white cursor-not-allowed'
                  : mqttStatus === 'connecting'
                    ? 'bg-yellow-500 text-white cursor-wait'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
              >
                {mqttStatus === 'connected' ? '✓ 已連線' :
                  mqttStatus === 'connecting' ? '連線中...' :
                    '連線 MQTT'}
              </button>
            </div>
          </div>
        )}

        {/* 連線狀態顯示（收起後） */}
        {!showMqttConfig && mqttStatus === 'connected' && (
          <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              <span className="text-sm text-green-800 font-medium">MQTT 已連線</span>
            </div>
            <button
              onClick={() => {
                setShowMqttConfig(true);
                setMqttStatus('disconnected');
                setVoltage('-- V');
              }}
              className="text-xs text-green-700 hover:text-green-900 underline"
            >
              查看設定
            </button>
          </div>
        )}

        {/* 插座名稱 */}
        <div className="mb-5">
          <label className="block text-gray-700 font-medium mb-2">插座名稱</label>
          <input
            type="text"
            value={plugName}
            readOnly
            className="w-full px-3 py-3 bg-gray-100 border border-gray-300 rounded-lg text-gray-600"
          />
        </div>

        {/* 登入密碼 */}
        <div className="mb-5">
          <label className="block text-gray-700 font-medium mb-2">請輸入登入密碼</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => {
              setLoginPassword(e.target.value);
              setErrorMessage('');
            }}
            onKeyPress={handleKeyPress}
            placeholder="請輸入密碼"
            disabled={mqttStatus !== 'connected' || loginLoading}
            className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
          {errorMessage && (
            <div className="text-red-600 text-sm mt-2">{errorMessage}</div>
          )}
          {mqttStatus !== 'connected' && (
            <div className="text-gray-500 text-sm mt-2">
              請先連線 MQTT 伺服器
            </div>
          )}
        </div>

        {/* 登入按鈕 */}
        <button
          onClick={handleLogin}
          disabled={mqttStatus !== 'connected' || loginLoading}
          className="w-full py-3 bg-gradient-to-r from-green-500 to-green-400 text-white rounded-lg text-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loginLoading ? '登入中...' : '登入'}
        </button>

        {/* 系統電壓規格 */}
        <div className="mt-8 bg-blue-500 text-white p-5 rounded-xl text-center">
          <p className="text-lg font-bold mb-2">系統電壓規格</p>
          <span className={`text-3xl font-bold ${voltageLoading ? 'opacity-70 animate-pulse' : ''}`}>
            {voltage}
          </span>
        </div>
      </div>
    </div>
  );
}
