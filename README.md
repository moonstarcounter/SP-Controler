# 操作面板 (Operation Panel) 設定說明

## 📁 專案的檔案結構

smartplug/
├── app/
│   ├── page.tsx
│   ├── operation/
│   │   └── page.tsx
│   ├── api/
│   │   ├── relay/
│   │   │   └── name/
│   │   │       └── route.ts
│   │   ├── logout/
│   │   │     └── route.ts
│   │   ├── mqtt/
│   │   │   ├── connect/
│   │   │   │   └── route.ts
│   │   │   └── status/
│   │   │       └── route.ts 
│   │   ├── plugName/
│   │   │   └── route.ts 
│   │   ├── voltage/
│   │   │   └── route.ts 
│   │   └── login/
│   │       └── route.ts
│   ├── globals.css
│   └── layout.tsx
├── lib/
│   └── mqtt.ts
│   └── mqtt-operation.ts
├── public/
├── .env.local
├── .env.local.example
├── package.json
├── tsconfig.json
├── next.config.ts
├── server.js
└── README_SETUP.md

## 🎯 操作面板功能說明

### 主頁面功能
1. **繼電器控制區**
   - 6 個繼電器卡片
   - 每個卡片包含：
     - 繼電器名稱（可自訂）
     - 開關切換器（左=開，右=關）
     - 點動按鈕（開啟 1 秒後自動關閉）
     - 修改按鈕（修改繼電器名稱）

2. **溫度顯示區**
   - 顯示當前溫度
   - 每 2 秒透過 MQTT 更新

3. **底部導航欄**
   - 主頁面：返回主控制頁
   - 溫度記錄：查看溫度歷史（尚待開發）
   - 系統設定：MQTT及設備名稱設定
   - 登出：返回登入頁面

### WebSocket 連線狀態
- 右上角顯示連線狀態
- 綠色：已連線
- 紅色：已斷線
- 自動重連機制（5 秒後）

## 📡 MQTT 主題設計

### 訂閱主題（接收）
| 主題 | 說明 | 訊息格式 |
|------|------|---------|
| `smartplug/temperature` | 溫度數據 | `{"temperature": 25.5}` |
| `smartplug/relay/state` | 繼電器狀態 | `{"id": 0, "state": true}` |
| `smartplug/relay/name` | 繼電器名稱 | `{"id": 0, "name": "客廳燈"}` |
| `smartplug/sensor/data` | 完整感測器數據 | 見下方範例 |

### 發布主題（發送）
| 主題 | 說明 | 訊息格式 |
|------|------|---------|
| `smartplug/relay/control` | 控制繼電器 | `{"id": 0, "state": true}` |
| `smartplug/relay/name` | 更新名稱 | `{"id": 0, "name": "新名稱"}` |
| `smartplug/sensor/data` | 請求數據 | `{"action": "request"}` |

## 🔧 ESP32 MCU 端 MQTT 實作

### 必須實作的功能

1. **溫度發布（每 2 秒）**
```cpp
// 定時發布溫度
void publishTemperature() {
  float temp = readTemperature();
  String payload = "{\"temperature\":" + String(temp, 1) + "}";
  mqttClient.publish("smartplug/plugID/temperature", payload.c_str());
}
```

2. **訂閱繼電器控制**
```cpp
void handleRelayControl(String payload) {
  JsonDocument doc;
  deserializeJson(doc, payload);
  int id = doc["id"];
  bool state = doc["state"];
  
  // 控制繼電器
  digitalWrite(relayPins[id], state ? HIGH : LOW);
  
  // 回報狀態
  String response = "{\"id\":" + String(id) + ",\"state\":" + String(state ? "true" : "false") + "}";
  mqttClient.publish("smartplug/plugID/relay/state", response.c_str());
}
```

3. **處理名稱更新**
```cpp
void handleRelayName(String payload) {
  JsonDocument doc;
  deserializeJson(doc, payload);
  int id = doc["id"];
  String name = doc["name"];
  
  // 儲存名稱到 EEPROM/Preferences
  saveRelayName(id, name);
  
  // 確認更新
  mqttClient.publish("smartplug/plugID/relay/name", payload.c_str());
}
```

4. **回應數據請求**
```cpp
void publishSensorData() {
  JsonDocument doc;
  doc["temperature"] = readTemperature();
  
  JsonArray relays = doc.createNestedArray("relays");
  for (int i = 0; i < 6; i++) {
    JsonObject relay = relays.createNestedObject();
    relay["id"] = i;
    relay["name"] = relayNames[i];
    relay["state"] = digitalRead(relayPins[i]) == HIGH;
  }
  
  String output;
  serializeJson(doc, output);
  mqttClient.publish("smartplug/plugID/sensor/data", output.c_str());
}
```

## 🎨 響應式設計

### 桌面（> 768px）
- 繼電器：3 行 × 2 列
- 底部導航：橫向排列
- 卡片間距：16px

### 平板（481px - 768px）
- 繼電器：3 行 × 2 列
- 底部導航：橫向排列
- 卡片間距：12px

### 手機（< 480px）
- 繼電器：3 行 × 2 列
- 底部導航：橫向排列（較小字體）
- 卡片間距：8px
- 按鈕文字縮小

### 滑動限制
- ✅ 允許上下滑動（overflow-y: auto）
- ❌ 禁止左右滑動（overflow-x: hidden）

## 🧪 測試建議

### 1. WebSocket 連線測試

在瀏覽器控制台測試：

```javascript
const ws = new WebSocket('ws://localhost:3000/api/ws/operation');
ws.onopen = () => console.log('WebSocket 已連線');
ws.onmessage = (e) => console.log('收到訊息:', e.data);
ws.send(JSON.stringify({ command: 'get_sensors' }));
```

### 2. MQTT 模擬測試

使用 MQTTX 或其他 MQTT 客戶端：

1. 連接到相同的 MQTT Broker
2. 訂閱 `smartplug/relay/control`
3. 發布到 `smartplug/temperature`：
   ```json
   {"temperature": 26.8}
   ```
4. 發布到 `smartplug/relay/state`：
   ```json
   {"id": 0, "state": true}
   ```

### 3. 功能測試清單

- [ ] 繼電器開關切換
- [ ] 點動功能（1 秒脈衝）
- [ ] 修改繼電器名稱
- [ ] 溫度即時更新
- [ ] WebSocket 自動重連
- [ ] 登出功能
- [ ] 響應式佈局（手機/平板/桌面）

## ⚠️ 注意事項

### WebSocket 設定

Next.js App Router 不原生支援 WebSocket，因此：
1. 使用 Pages Router (`pages/api/ws/operation.ts`)
2. 確保該檔案位於 `pages/api` 目錄下
3. WebSocket 端點：`ws://localhost:3000/api/ws/operation`

### MQTT 連線管理

1. **登入頁面**連線 MQTT → 儲存客戶端實例
2. **操作頁面**使用相同的 MQTT 連線
3. **登出時**斷開 MQTT 連線

### 效能優化

1. 溫度更新頻率：2 秒（避免過於頻繁）
2. WebSocket 心跳：30 秒 ping/pong
3. MQTT QoS：建議使用 QoS 1（至少一次傳遞）

## 🐛 疑難排解

### WebSocket 連線失敗

1. 確認 `pages/api/ws/operation.ts` 檔案存在
2. 檢查瀏覽器控制台錯誤訊息
3. 確認沒有防火牆阻擋

### MQTT 訊息未收到

1. 檢查 MQTT Broker 連線狀態
2. 確認主題名稱正確
3. 查看伺服器控制台日誌

### 繼電器狀態不同步

1. 確認 ESP32 有正確回報狀態
2. 檢查 MQTT 主題訂閱
3. 查看 WebSocket 訊息是否正常廣播

## 📞 後續開發

- [ ] 溫度記錄頁面
- [ ] 系統設定頁面
- [ ] 定時器功能
- [ ] 場景模式
- [ ] 歷史數據圖表

## 🔗 相關文件

- [MQTT.js 文件](https://github.com/mqttjs/MQTT.js)
- [ws 套件文件](https://github.com/websockets/ws)
- [Next.js API Routes](https://nextjs.org/docs/pages/building-your-application/routing/api-routes)
