import { NextResponse } from 'next/server';
import { getMqttStatus, getMqttClient, getClientId } from '@/lib/mqtt';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');

  const connected = getMqttStatus(clientId || undefined);
  const client = getMqttClient(clientId || undefined);

  return NextResponse.json({
    connected,
    clientId: clientId || '未連接',
    status: connected ? 'connected' : 'disconnected',
    mqttConnected: client?.connected || false,
    timestamp: new Date().toISOString(),
    message: connected ? 'MQTT 已連線' : 'MQTT 未連線'
  });
}
