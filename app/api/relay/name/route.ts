import { NextRequest, NextResponse } from 'next/server';
import { updateRelayName, getMqttClient } from '@/lib/mqtt-operation';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, name, clientId } = body;

    // 驗證輸入
    if (id === undefined || !name || !clientId) {
      return NextResponse.json(
        { success: false, error: '缺少必要參數 (id, name, clientId)' },
        { status: 400 }
      );
    }

    // 檢查 MQTT 是否連線
    const mqttClient = getMqttClient(clientId);
    if (!mqttClient || !mqttClient.connected) {
      return NextResponse.json(
        { success: false, error: 'MQTT 未連線' },
        { status: 503 }
      );
    }

    if (id < 0 || id > 5) {
      return NextResponse.json(
        { success: false, error: '無效的繼電器 ID' },
        { status: 400 }
      );
    }

    if (name.length === 0 || name.length > 20) {
      return NextResponse.json(
        { success: false, error: '名稱長度必須在 1-20 個字元之間' },
        { status: 400 }
      );
    }

    console.log(`更新繼電器 ${id} 名稱為: ${name} (Client: ${clientId})`);

    // 通過 MQTT 發送名稱更新
    const success = updateRelayName(id, name, undefined, clientId);

    if (success) {
      return NextResponse.json({
        success: true,
        relay_id: id,
        name: name
      });
    } else {
      return NextResponse.json(
        { success: false, error: 'MQTT 發布失敗' },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('更新繼電器名稱錯誤:', error);
    return NextResponse.json(
      { success: false, error: error.message || '伺服器錯誤' },
      { status: 500 }
    );
  }
}