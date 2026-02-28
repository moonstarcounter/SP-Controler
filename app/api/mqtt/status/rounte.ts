import { NextResponse } from 'next/server';
import { getMqttStatus, getMqttClient, getClientId } from '@/lib/mqtt';

export async function GET() {
  const connected = getMqttStatus();
  const mqttClient = getMqttClient();
  
  // 收集詳細的狀態資訊
  let clientId = getClientId();
  let detailedInfo = {
    clientId: clientId || '未連接',
    connected,
    mqttClientExists: !!mqttClient,
    mqttConnected: mqttClient?.connected || false,
    mqttDisconnected: mqttClient?.disconnected || true,
    timestamp: new Date().toISOString(),
  };
  
  return NextResponse.json({ 
    ...detailedInfo,
    message: connected ? 'MQTT 已連線' : 'MQTT 未連線'
  });
}
