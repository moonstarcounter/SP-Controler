import { NextResponse } from 'next/server';
import { getPlugName, getMqttStatus } from '@/lib/mqtt';

export async function GET() {
  // 檢查 MQTT 是否連線
  if (!getMqttStatus()) {
    return NextResponse.json(
      { error: 'MQTT 未連線' },
      { status: 503 }
    );
  }

  const plugName = getPlugName();
  
  return NextResponse.json({ 
    plugName 
  });
}