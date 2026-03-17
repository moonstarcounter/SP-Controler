import { NextResponse } from 'next/server';
import { getPlugName, getMqttStatus } from '@/lib/mqtt';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');

  // 檢查 MQTT 是否連線
  if (!getMqttStatus(clientId || undefined)) {
    return NextResponse.json(
      { error: 'MQTT 未連線' },
      { status: 503 }
    );
  }

  const plugName = getPlugName(clientId || undefined);

  return NextResponse.json({
    plugName
  });
}