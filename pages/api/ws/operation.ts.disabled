import { NextApiRequest } from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import {
  addWsClient,
  removeWsClient,
  handleWsMessage,
  getMqttClient,
  getCurrentClientId
} from '@/lib/mqtt-operation';

// 擴展 NextApiResponse 型別
interface NextApiResponseWithSocket extends Response {
  socket: Duplex & {
    server: any;
  };
}

// 全域 WebSocket 伺服器實例
let wss: WebSocketServer | null = null;
let upgradeListenerAdded = false;

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req: NextApiRequest, res: any) {
  console.log('═══════════════════════════════════════════════');
  console.log('🔧 WebSocket API 路由被調用');
  console.log('請求方法:', req.method);
  console.log('請求 URL:', req.url);
  console.log('═══════════════════════════════════════════════');

  // 檢查 socket.server 是否存在
  if (!res.socket?.server) {
    console.error('❌ 致命錯誤: res.socket.server 不存在');
    console.error('這可能表示 Next.js 配置有問題');
    res.status(500).json({
      error: 'Server socket not available',
      hint: '請檢查 Next.js 版本和配置'
    });
    return;
  }

  // 初始化 WebSocket 伺服器（只初始化一次）
  if (!wss) {
    console.log('🔧 創建新的 WebSocketServer 實例...');
    try {
      wss = new WebSocketServer({
        noServer: true,
        clientTracking: true,
        perMessageDeflate: false
      });
      res.socket.server.wss = wss;
      console.log('✅ WebSocketServer 實例已創建');
      console.log('   - noServer: true (手動處理升級)');
      console.log('   - clientTracking: true (追蹤客戶端)');
    } catch (error) {
      console.error('❌ 創建 WebSocketServer 失敗:', error);
      res.status(500).json({ error: 'Failed to create WebSocket server' });
      return;
    }
  } else {
    console.log('✅ 使用現有的 WebSocketServer 實例');
  }

  // 設置升級請求處理器（只設置一次）
  if (!upgradeListenerAdded && res.socket.server) {
    console.log('🔧 設置 HTTP 升級請求監聽器...');

    const server = res.socket.server;

    // 移除舊的監聽器（如果有）
    server.removeAllListeners('upgrade');

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   收到 WebSocket 升級請求                     ║');
      console.log('╚═══════════════════════════════════════════════╝');
      console.log('📋 請求 URL:', request.url);
      console.log('📋 請求方法:', request.method);
      console.log('📋 請求頭:', JSON.stringify(request.headers, null, 2));

      // 檢查路徑
      if (!request.url || !request.url.includes('/api/ws/operation')) {
        console.log('❌ 拒絕升級: 路徑不匹配');
        console.log('   預期路徑包含: /api/ws/operation');
        console.log('   實際路徑:', request.url);
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // 檢查 WebSocket 伺服器是否存在
      if (!wss) {
        console.error('❌ 致命錯誤: WebSocket 伺服器未初始化');
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
        return;
      }

      console.log('✅ 路徑匹配，開始處理升級請求...');

      try {
        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          console.log('✅ WebSocket 升級成功');
          console.log('   - WebSocket readyState:', ws.readyState);
          console.log('   - WebSocket OPEN 值:', WebSocket.OPEN);

          // 觸發連接事件
          wss!.emit('connection', ws, request);
          console.log('✅ 已觸發 connection 事件');
        });
      } catch (error) {
        console.error('❌ 處理升級請求時發生錯誤:', error);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    });

    upgradeListenerAdded = true;
    console.log('✅ HTTP 升級請求監聽器已設置');
  }

  // 設置 WebSocket 連接事件處理器（只設置一次）
  if (wss && wss.listenerCount('connection') === 0) {
    console.log('🔧 設置 WebSocket connection 事件處理器...');

    wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      console.log('╔═══════════════════════════════════════════════╗');
      console.log('║   新的 WebSocket 連接建立                     ║');
      console.log('╚═══════════════════════════════════════════════╝');

      // 解析 clientId
      let clientId = '';
      try {
        const url = new URL(request.url || '', `http://${request.headers.host}`);
        clientId = url.searchParams.get('clientId') || '';
        console.log('📋 從 URL 解析 clientId:', clientId || '(未提供)');
      } catch (error) {
        console.error('❌ 解析 URL 失敗:', error);
      }

      // 備用方案：從 MQTT 獲取
      if (!clientId) {
        clientId = getCurrentClientId();
        console.log('📋 從 MQTT 獲取 clientId:', clientId || '(未找到)');
      }

      // 最終備用方案
      if (!clientId) {
        clientId = `ws_client_${Date.now()}`;
        console.warn('⚠️ 使用生成的 clientId:', clientId);
      }

      // 檢查 WebSocket 狀態
      console.log('📋 WebSocket readyState:', ws.readyState);
      console.log('📋 WebSocket OPEN 常數:', WebSocket.OPEN);

      if (ws.readyState !== WebSocket.OPEN) {
        console.error('❌ WebSocket 未處於 OPEN 狀態');
        try {
          ws.close(1002, 'Connection not ready');
        } catch (e) {
          console.error('關閉 WebSocket 失敗:', e);
        }
        return;
      }

      // 檢查 MQTT 連接
      const mqttClient = getMqttClient();
      if (!mqttClient || !mqttClient.connected) {
        console.warn('⚠️ MQTT 未連接');
        try {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'MQTT 未連接，請先在登入頁面連接 MQTT'
          }));
          ws.close(1011, 'MQTT not connected');
        } catch (e) {
          console.error('發送錯誤訊息失敗:', e);
        }
        return;
      }

      // 添加客戶端
      try {
        addWsClient(ws, clientId);
        console.log(`✅ 客戶端已註冊, clientId: ${clientId}`);
      } catch (error) {
        console.error('❌ 註冊客戶端失敗:', error);
        ws.close(1011, 'Failed to register client');
        return;
      }

      // 發送歡迎訊息
      try {
        const welcomeMsg = {
          type: 'connected',
          message: 'WebSocket 連接成功',
          clientId: clientId,
          timestamp: Date.now(),
          mqttConnected: true
        };
        ws.send(JSON.stringify(welcomeMsg));
        console.log('✅ 已發送歡迎訊息');
      } catch (error) {
        console.error('❌ 發送歡迎訊息失敗:', error);
      }

      // 處理訊息
      ws.on('message', (message: Buffer) => {
        const msg = message.toString();
        console.log(`📨 收到訊息 [${clientId}]:`, msg.substring(0, 100));
        try {
          handleWsMessage(msg, ws, clientId);
        } catch (error) {
          console.error('❌ 處理訊息失敗:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: '處理訊息失敗'
          }));
        }
      });

      // 處理關閉
      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`🔌 連接關閉 [${clientId}]`);
        console.log(`   - Code: ${code}`);
        console.log(`   - Reason: ${reason.toString() || '無'}`);
        removeWsClient(ws, clientId);
      });

      // 處理錯誤
      ws.on('error', (error) => {
        console.error(`❌ WebSocket 錯誤 [${clientId}]:`, error);
      });

      // 設置心跳
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch (e) {
            console.error('發送心跳失敗:', e);
            clearInterval(heartbeat);
          }
        } else {
          clearInterval(heartbeat);
        }
      }, 30000);

      ws.on('close', () => clearInterval(heartbeat));
    });

    console.log('✅ connection 事件處理器已設置');
  }

  // 返回狀態資訊
  const mqttClient = getMqttClient();
  const status = {
    status: 'WebSocket server running',
    timestamp: new Date().toISOString(),
    wssInitialized: !!wss,
    wssClients: wss?.clients.size || 0,
    mqttConnected: mqttClient?.connected || false,
    upgradeListenerAdded,
    currentClientId: getCurrentClientId() || 'none'
  };

  console.log('📊 伺服器狀態:', JSON.stringify(status, null, 2));
  console.log('═══════════════════════════════════════════════\n');

  res.status(200).json(status);
}