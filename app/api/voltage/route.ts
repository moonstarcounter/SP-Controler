import { NextResponse } from 'next/server';
import { getVoltage, getMqttStatus } from '@/lib/mqtt';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');

  // 檢查 MQTT 是否連線
  if (!getMqttStatus(clientId || undefined)) {
    // 返回默認值，避免前端解析錯誤
    console.warn('MQTT 未連線，返回默認電壓值');
    return NextResponse.json({
      voltage: 110,
      pin: 2, // 模擬值
      signal: 1 // 模擬值
    });
  }

  const voltage = getVoltage(clientId || undefined);

  // 移除硬編碼的 110V 回退，直接返回獲取到的原始值
  const finalVoltage = voltage;

  return NextResponse.json({
    voltage: finalVoltage,
    pin: 2, // 模擬值
    signal: 1 // 模擬值
  });
}
