import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { publishMqtt, MqttTopics } from '@/lib/mqtt';

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.json');

// 讀取設定
export async function GET() {
    try {
        const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
        const settings = JSON.parse(data);
        return NextResponse.json(settings);
    } catch (error) {
        console.error('讀取設定檔案失敗:', error);
        return NextResponse.json(
            { error: '無法讀取設定檔案' },
            { status: 500 }
        );
    }
}

// 更新設定
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // 驗證必要的欄位
        if (!body.mqtt || !body.mqtt.broker || !body.mqtt.port || !body.mqtt.clientId) {
            return NextResponse.json(
                { error: '缺少必要的設定欄位' },
                { status: 400 }
            );
        }

        // 讀取現有設定以檢查插座名稱是否有變化
        const existingData = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
        const oldPlugName = existingData.plugName || 'SmartPlug';
        const newPlugName = body.plugName || 'SmartPlug';
        const plugId = body.plugId || existingData.plugId || 'defaultPlug';

        // 保留原有的 loginPassword 如果沒有提供（空白表示不修改）
        if (!body.loginPassword) {
            body.loginPassword = existingData.loginPassword;
        }

        // 保護固定 ClientID：確保臨時會話 ID 不會寫回設定檔
        if (existingData.mqtt && existingData.mqtt.clientId) {
            body.mqtt.clientId = existingData.mqtt.clientId;
        }

        // 寫入檔案
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(body, null, 4), 'utf-8');

        // 同時複製到 public/data/setting.json 以供前端讀取
        const publicPath = path.join(process.cwd(), 'public', 'data', 'setting.json');
        await fs.writeFile(publicPath, JSON.stringify(body, null, 4), 'utf-8');

        // 如果插座名稱有變化，透過 MQTT 廣播給所有 Client 端
        if (oldPlugName !== newPlugName && newPlugName.trim() !== '') {
            const topic = MqttTopics.plugName(plugId);
            const payload = JSON.stringify({ plugName: newPlugName });

            const broadcastSuccess = publishMqtt(topic, payload, { qos: 1 }, body.mqtt.clientId);

            if (broadcastSuccess) {
                console.log(`📤 已透過 MQTT 廣播插座名稱更新: ${newPlugName} (PlugID: ${plugId})`);
            } else {
                console.warn(`⚠️  MQTT 廣播插座名稱失敗，可能 MQTT 未連線`);
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('儲存設定檔案失敗:', error);
        return NextResponse.json(
            { error: '儲存設定失敗' },
            { status: 500 }
        );
    }
}
