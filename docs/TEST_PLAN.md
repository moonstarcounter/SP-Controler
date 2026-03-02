# SmartPlug 系統整合測試計劃

## 已完成的主要改進

### 1. MQTT 主題結構改進
- **ESP32C3端**: 
  - `announceTopic(plugId)` → `smartplug/{plugId}/announce`
  - `announceResponseTopic(plugId, clientId)` → `smartplug/{plugId}/{clientId}/announce`
- **Next.js端**:
  - 同步修改了 `lib/mqtt.ts` 中的主題定義
  - 確保兩端主題格式完全一致

### 2. Client 註冊持久化機制
- **ESP32C3 Web界面**: 提供 `/api/register-client` API 註冊Client
- **NVS儲存**: 註冊時自動保存到 `mqtt-clients` 命名空間
- **開機載入**: 啟動時自動載入所有已註冊的Clients
- **announce處理**: 收到announce時檢查Client是否已在NVS中註冊

### 3. announce處理流程優化
- **即時響應**: 收到announce後立即發送電壓資訊
- **狀態推送**: 自動推送設備名稱、溫度、繼電器狀態
- **訂閱管理**: 僅對已註冊Client訂閱控制主題

### 4. 登錄流程改進
- **Next.js登錄頁面**: 已包含PlugID驗證和MQTT連線配置
- **PlugID驗證**: 確保格式正確（至少8字元，英數混合）
- **MQTT連線**: 連線成功後保存ClientId到設定檔案

## 測試流程

### 測試準備
1. **ESP32C3設備**:
   - 燒錄修改後的程式碼
   - 連接網路（乙太網路或WiFi）
   - 確認IP位址 (http://smartplug.local 或 http://<IP>)

2. **Next.js專案**:
   ```bash
   cd c:\Users\chuwe\Downloads\SP_Experiment\smartplug_pack
   npm run dev
   ```
   - 訪問 http://localhost:3000

3. **MQTT Broker**:
   - 預設使用 broker.emqx.io:1883
   - 可根據需要修改為本地MQTT伺服器

### 測試步驟

#### 步驟1: ESP32C3 Client註冊
1. 訪問ESP32C3 Web界面 (http://smartplug.local)
2. 在註冊頁面輸入:
   - PlugID: `sp123456` (或自定義)
   - ClientID: `client_001` (或自定義)
   - MQTT Broker: `broker.emqx.io`
   - Port: `1883`
3. 點擊「註冊Client」
4. 確認顯示「註冊成功」

#### 步驟2: Next.js登錄連線
1. 訪問 http://localhost:3000
2. 輸入PlugID (與ESP32C3註冊時使用的相同)
3. 配置MQTT連線:
   - Broker: `broker.emqx.io`
   - Port: `1883` (或8083 for WebSocket)
   - ClientID: `client_001` (與ESP32C3註冊時相同)
4. 點擊「連線MQTT」
5. 觀察Console日誌:
   ```
   ✅ MQTT 連線成功
   📤 延遲 1.0 秒: 已發送電壓請求到: smartplug/sp123456/client_001/request
   📤 延遲 1.5 秒: 已發送 announce 到: smartplug/sp123456/announce
   ```

#### 步驟3: ESP32C3響應announce
1. 觀察ESP32C3 Serial Monitor:
   ```
   📨 收到 MQTT 訊息:
     Topic: smartplug/sp123456/announce
     Payload: {"clientId":"client_001","plugId":"sp123456"}
   🔍 Client 註冊狀態: 已註冊
   ✅ 訂閱 Client 主題: client_001
   ⚡ 發送電壓資訊...
   📤 發布電壓: 110V
   📤 發布設備名稱: SmartPlug
   📤 發布溫度: 25.0°C
   📤 發布所有繼電器狀態...
   ```

#### 步驟4: Next.js接收數據
1. 觀察Next.js頁面變化:
   - 插座名稱從「SmartPlug」變為從ESP32C3收到的名稱
   - 系統電壓顯示為「AC-110V」
   - MQTT狀態變為「已連線」

2. 輸入登入密碼 (預設: `123456`)
3. 點擊「登入」
4. 應成功跳轉到操作頁面 (/operation)

### 預期結果

#### 成功指標
1. ✅ MQTT連線成功建立
2. ✅ ESP32C3正確響應announce訊息
3. ✅ Next.js成功接收電壓和設備名稱
4. ✅ 登入成功進入操作頁面
5. ✅ 操作頁面WebSocket連線正常

#### 錯誤處理
1. **PlugID不匹配**: ESP32C3會忽略未註冊Client的announce
2. **MQTT連線失敗**: Next.js顯示連線錯誤訊息
3. **密碼錯誤**: 顯示登入錯誤訊息

### 故障排除

#### 常見問題
1. **MQTT連線超時**:
   - 檢查網路連線
   - 確認MQTT Broker可訪問
   - 嘗試使用WebSocket埠 (8083)

2. **ESP32C3無回應**:
   - 確認ESP32C3已連接到相同網路
   - 檢查Serial Monitor日誌
   - 確認Client已在ESP32C3註冊

3. **PlugID驗證失敗**:
   - 確保兩端使用相同PlugID
   - 確認PlugID符合格式要求 (至少8字元，英數混合)

#### 日誌檢查
- **ESP32C3 Serial Monitor**: 查看MQTT連線和訊息處理日誌
- **Next.js Console**: 查看瀏覽器開發者工具Console
- **Next.js終端**: 查看伺服器端日誌

### 多設備測試
1. **多個ESP32C3設備**:
   - 每個設備設定不同PlugID (如: sp123456, sp789012)
   - Next.js可分別連接到不同設備

2. **多個Next.js Client**:
   - 使用不同ClientID註冊到同一個ESP32C3
   - ESP32C3會為每個Client分別訂閱主題

## 總結
本系統現在支援:
1. 多設備區分 (透過PlugID)
2. 多Client管理 (透過ClientID)
3. 持久化註冊 (重啟後保留註冊資訊)
4. 完整announce/response流程
5. 安全登入機制

完成以上測試後，系統應可正常運作於實際環境。