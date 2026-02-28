import { NextResponse } from 'next/server';
import { getVoltage, getMqttStatus } from '@/lib/mqtt';

export async function GET() {
  // 檢查 MQTT 是否連線
  if (!getMqttStatus()) {
    return NextResponse.json(
      { error: 'MQTT 未連線' },
      { status: 503 }
    );
  }

  const voltage = getVoltage();
  
  return NextResponse.json({ 
    voltage,
    pin: 2, // 模擬值
    signal: 1 // 模擬值
  });
}