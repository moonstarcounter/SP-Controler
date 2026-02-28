import { NextRequest, NextResponse } from 'next/server';
import { getMqttStatus } from '@/lib/mqtt';
import fs from 'fs/promises';
import path from 'path';

// 設定檔案路徑
const SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.json');

async function getStoredPassword(): Promise<string> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(data);
    return settings.loginPassword || '123456'; // 後備預設密碼
  } catch (error) {
    console.error('讀取設定檔案失敗，使用預設密碼:', error);
    return '123456'; // 預設密碼
  }
}

export async function POST(request: NextRequest) {
  try {
    // 檢查 MQTT 是否連線
    if (!getMqttStatus()) {
      return NextResponse.json(
        { message: 'MQTT 未連線，無法登入' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { password } = body;

    if (!password) {
      return NextResponse.json(
        { message: '請輸入密碼' },
        { status: 400 }
      );
    }

    console.log('收到登入請求');

    // 從設定檔案讀取密碼
    const storedPassword = await getStoredPassword();

    // 驗證密碼
    if (password === storedPassword) {
      console.log('✅ 密碼驗證成功');
      return NextResponse.json({
        success: true,
        message: '登入成功'
      });
    } else {
      console.log('❌ 密碼驗證失敗');
      return NextResponse.json(
        { message: '密碼錯誤，請重新輸入。' },
        { status: 401 }
      );
    }
  } catch (error: any) {
    console.error('登入錯誤:', error);
    return NextResponse.json(
      { message: '登入失敗，請稍後再試。' },
      { status: 500 }
    );
  }
}
