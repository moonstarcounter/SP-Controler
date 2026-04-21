'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();

  // 核心：使用 useRef 記錄目前分頁唯一的技術標籤 (Session ID)
  // 這能解決 React 閉包導致 setInterval 抓到舊 ID 的問題
  const activeClientIdRef = useRef<string | null>(null);

  // --- UI 狀態 ---
  const [plugId, setPlugId] = useState('');
  const [plugIdError, setPlugIdError] = useState('');
  const [identity, setIdentity] = useState('');
  const [identityError, setIdentityError] = useState('');
  const [mqttStatus, setMqttStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [isRegistered, setIsRegistered] = useState<boolean | null>(null);

  const [mqttConfig, setMqttConfig] = useState({
    broker: 's4eb1262.ala.cn-hangzhou.emqxsl.cn',
    port: '8084',
    clientId: 's4eb1262',
    username: 'chuwm',
    password: 'chuwengming'
  });

  const [plugName, setPlugName] = useState('SmartPlug');
  const [voltage, setVoltage] = useState<string>('-- V');
  const [voltageLoading, setVoltageLoading] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showMqttConfig, setShowMqttConfig] = useState(true);

  // --- 生命週期與連線檢查 ---

  useEffect(() => {
    // 1. 初始化即時清空狀態，防止上一回合殘影
    setMqttStatus('disconnected');
    setIsRegistered(null);

    const loadInitialSettings = async () => {
      try {
        const response = await fetch('/data/setting.json');
        if (!response.ok) throw new Error('無法讀取設定');
        const data = await response.json();

        // 2. 建立分頁隔離會話標籤：${baseId}_tab_${random}
        const baseId = data.mqtt?.clientId || 's4eb1262';
        const savedCid = sessionStorage.getItem('mqttClientId');
        // 優先沿用 sessionStorage 內的 session，若無則生成新的
        const sessionClientId = savedCid || `${baseId}_tab_${Math.random().toString(16).slice(2, 6)}`;

        activeClientIdRef.current = sessionClientId;

        setMqttConfig({
          broker: data.mqtt?.broker || 's4eb1262.ala.cn-hangzhou.emqxsl.cn',
          port: data.mqtt?.port || '8084',
          clientId: sessionClientId,
          username: data.mqtt?.username || 'chuwm',
          password: data.mqtt?.password || 'chuwengming'
        });

        if (data.plugId) setPlugId(data.plugId);

        // 3. 立即啟動第一次連線狀態檢查
        checkMqttStatus(sessionClientId);
      } catch (error) {
        console.error('初始化失敗:', error);
      }
    };

    const checkMqttStatus = async (forcedId?: string) => {
      // 核心隔離邏輯：只詢問專屬技術標籤的狀態，絕不詢問全域標籤
      const cid = forcedId || activeClientIdRef.current;
      if (!cid || cid === 's4eb1262') return;

      try {
        const response = await fetch(`/api/mqtt/status?clientId=${cid}`);
        const data = await response.json();

        if (data.isRegistered !== undefined) {
          setIsRegistered(data.isRegistered);
          if (data.connected && data.isRegistered === false) {
            // 先重置狀態與斷線，再顯示警告，防止 alert 阻塞導致輪詢循環
            const logoutId = cid;
            setIsRegistered(null);
            setMqttStatus('disconnected');
            handleLogoutSilently(logoutId);

            setTimeout(() => alert('身分或插座識別碼未註冊，請檢查'), 100);
            return;
          }
        }

        if (data.connected) {
          setMqttStatus('connected');
          setShowMqttConfig(false);
          const savedIdentity = sessionStorage.getItem('mqttIdentity');
          if (savedIdentity) setIdentity(savedIdentity);
          fetchPlugName(cid);
          fetchVoltage(cid);
        } else {
          setMqttStatus('disconnected');
          setIsRegistered(null);
        }
      } catch (e) { }
    };

    loadInitialSettings();

    // 啟動定時輪詢，使用 Ref 確保讀取到最新 ID
    const interval = setInterval(() => checkMqttStatus(), 5000);
    return () => clearInterval(interval);
  }, []);

  // --- 各類功能函式 ---

  const validatePlugId = (val: string) => {
    if (!val) return '請輸入 PlugID';
    if (!/^sp\d+$/.test(val)) return '格式須為 sp+數字 (如 sp123456)';
    return '';
  };

  const validateIdentity = (val: string) => {
    if (val.length < 2) return '身分碼至少需 2 字元';
    if (!/^[a-zA-Z0-9_]+$/.test(val)) return '僅限英數與下底線';
    return '';
  };

  const handlePlugIdChange = (value: string) => {
    setPlugId(value);
    setPlugIdError(validatePlugId(value));
  };

  const handleIdentityChange = (value: string) => {
    setIdentity(value);
    setIdentityError(validateIdentity(value));
  };

  const connectMqtt = async () => {
    if (!plugId || !identity || plugIdError || identityError) {
      alert('請填寫正確的 PlugID 與身分');
      return;
    }
    setMqttStatus('connecting');
    setIsRegistered(null);
    try {
      // 1. 儲存 PlugID 到伺服器 (保護 clientId 欄位不被覆寫)
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugId,
          mqtt: { ...mqttConfig, clientId: undefined } // 故意不傳送 clientId 以觸發後端保護
        })
      });

      // 2. 請求 MQTT 連線
      const res = await fetch('/api/mqtt/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mqttConfig, identity, plugId })
      });

      if (!res.ok) throw new Error('Connect failed');

      localStorage.setItem('lastIdentity', identity); // 額外：記憶上次輸入
      sessionStorage.setItem('mqttClientId', mqttConfig.clientId);
      sessionStorage.setItem('mqttIdentity', identity);
      sessionStorage.setItem('plugId', plugId);

      console.log('連線請求已發送:', mqttConfig.clientId);
    } catch (e) {
      alert('連線伺服器失敗');
      setMqttStatus('disconnected');
    }
  };

  const handleLogoutSilently = async (cid: string) => {
    try {
      // 傳送登出請求，但不等待回應 (避免阻塞)
      fetch(`/api/logout?clientId=${cid}`, { method: 'POST' }).catch(() => { });

      // 徹底清除本地狀態
      sessionStorage.clear();
      setMqttStatus('disconnected');
      setIsRegistered(null);
      setShowMqttConfig(true);
    } catch (e) { }
  };

  const handleLogout = async () => {
    const cid = activeClientIdRef.current || sessionStorage.getItem('mqttClientId');

    // 重置前端狀態 (優先執行，確保 UI 即時反應)
    sessionStorage.clear();
    setMqttStatus('disconnected');
    setIsRegistered(null);
    setShowMqttConfig(true);
    setVoltage('-- V');

    // 發送登出請求給後端
    if (cid) {
      try {
        await fetch(`/api/logout?clientId=${cid}`, { method: 'POST' });
      } catch (e) {
        console.error('登出 API 呼叫失敗:', e);
      }
    }
  };

  const fetchPlugName = async (cid: string) => {
    try {
      const res = await fetch(`/api/plugName?clientId=${cid}`);
      const data = await res.json();
      if (data.plugName) setPlugName(data.plugName);
    } catch (e) { }
  };

  const fetchVoltage = async (cid: string) => {
    setVoltageLoading(true);
    try {
      const res = await fetch(`/api/voltage?clientId=${cid}`);
      const data = await res.json();
      if (data.voltage) setVoltage(data.voltage);
    } catch (e) { }
    setVoltageLoading(false);
  };

  const handleLogin = async () => {
    if (!loginPassword) return;
    setLoginLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword, clientId: activeClientIdRef.current })
      });
      if (res.ok) router.push('/operation');
      else setErrorMessage('密碼錯誤');
    } catch (e) {
      setErrorMessage('網路通訊失敗');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && mqttStatus === 'connected' && isRegistered === true && !loginLoading) {
      handleLogin();
    }
  };

  // --- UI ---

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-5">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-100">
        <h1 className="text-3xl font-extrabold text-blue-600 text-center mb-8 tracking-tight">智能家居遙控系統</h1>

        <div className="space-y-4 mb-8">
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">身分標籤 (Identity)</label>
            <input type="text" value={identity} onChange={(e) => handleIdentityChange(e.target.value)} placeholder="例如 user1" disabled={mqttStatus !== 'disconnected'} className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all disabled:opacity-60 text-gray-900 font-medium" />
            {identityError && <p className="text-red-500 text-xs mt-1">{identityError}</p>}
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">插座識別碼 (PlugID)</label>
            <input type="text" value={plugId} onChange={(e) => handlePlugIdChange(e.target.value)} placeholder="例如 sp123456" disabled={mqttStatus !== 'disconnected'} className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all disabled:opacity-60 text-gray-900 font-medium" />
            {plugIdError && <p className="text-red-500 text-xs mt-1">{plugIdError}</p>}
          </div>
        </div>

        {showMqttConfig && (
          <div className="mb-8 p-5 bg-gradient-to-br from-gray-50 to-white rounded-2xl border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-gray-800">MQTT 通訊服務</h2>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase text-white shadow-sm ${mqttStatus === 'connected' ? 'bg-green-500' : mqttStatus === 'connecting' ? 'bg-amber-500' : 'bg-slate-400'}`}>
                {mqttStatus === 'connected' ? '就緒' : mqttStatus === 'connecting' ? '建立中' : '未連線'}
              </span>
            </div>
            <button onClick={connectMqtt} disabled={mqttStatus !== 'disconnected' || !identity || !plugId || !!identityError || !!plugIdError} className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-all shadow-lg shadow-blue-200 disabled:bg-gray-300 disabled:shadow-none">啟動連線服務</button>
          </div>
        )}

        {!showMqttConfig && mqttStatus === 'connected' && (
          <div className="mb-6 p-4 bg-green-50 rounded-2xl border border-green-100 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-ping"></span>
              <span className="text-xs text-green-700 font-bold">MQTT 通訊通道已連通</span>
            </div>
            <button onClick={handleLogout} className="text-xs text-green-600 hover:text-green-800 font-bold underline decoration-2 underline-offset-2">切換身分</button>
          </div>
        )}

        <div className="space-y-5">
          <div className="relative group">
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => { setLoginPassword(e.target.value); setErrorMessage(''); }}
              onKeyPress={handleKeyPress}
              disabled={mqttStatus !== 'connected' || isRegistered !== true || loginLoading}
              className="w-full px-4 py-4 bg-white border-2 border-gray-100 rounded-xl text-lg focus:border-green-500 outline-none transition-all disabled:bg-gray-50"
              placeholder={mqttStatus === 'connected' && isRegistered === true ? '請輸入系統密碼' : '等待啟動服務...'}
            />
            {errorMessage && <p className="text-red-500 text-xs mt-2 font-medium">{errorMessage}</p>}
            {(mqttStatus !== 'connected' || isRegistered !== true) && (
              <p className="text-gray-400 text-[10px] mt-2 font-medium">
                {mqttStatus !== 'connected' ? '⚠️ 需要先啟動 MQTT 服務' : isRegistered === null ? '⏳ 正在與 ESP32 進行身分驗證...' : '❌ 驗證失敗'}
              </p>
            )}
          </div>

          <button onClick={handleLogin} disabled={mqttStatus !== 'connected' || isRegistered !== true || loginLoading} className="w-full py-4 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl text-lg font-black shadow-xl shadow-green-100 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-40 disabled:scale-100">{loginLoading ? '登入中...' : '進入操作面板'}</button>
        </div>

        <div className="mt-10 bg-slate-800 p-6 rounded-2xl text-center shadow-xl">
          <p className="text-[12px] font-black text-slate-400 uppercase tracking-[0.2em] mb-2">設備電壓</p>
          <span className={`text-4xl font-black text-white ${voltageLoading ? 'opacity-30' : ''}`}>
            AC {String(voltage).includes('V') ? String(voltage).replace('V', '').trim() : voltage} V
          </span>
        </div>
      </div>
    </div>
  );
}
