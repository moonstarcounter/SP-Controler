import { NextRequest, NextResponse } from 'next/server';
import { disconnectMqtt, clearClientCache } from '@/lib/mqtt';

export async function POST(request: NextRequest) {
  try {
    let clientId: string | null = null;

    // 優先從 Query String 讀取 (相容部分前端實作)
    const { searchParams } = new URL(request.url);
    clientId = searchParams.get('clientId');

    // 嘗試從 Body 讀取
    if (!clientId) {
      try {
        const body = await request.json();
        clientId = body.clientId;
      } catch (e) {
        // 如果 Body 為空或非 JSON，忽略錯誤，因為可能已經從 Query 取得
      }
    }

    console.log(`收到登出請求: ${clientId || '未知 ID'}`);

    // 清除 session 資料快取
    if (clientId) {
      clearClientCache(clientId);
      // 斷開指定的 MQTT 連線
      disconnectMqtt(clientId);
    }

    return NextResponse.json({
      success: true,
      message: '已成功登出'
    });
  } catch (error: any) {
    console.error('登出錯誤:', error);
    return NextResponse.json(
      { success: false, message: error.message || '登出失敗' },
      { status: 500 }
    );
  }
}