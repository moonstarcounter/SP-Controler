import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const FACTORY_SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.factory.json');

export async function GET() {
    try {
        const data = await fs.readFile(FACTORY_SETTINGS_PATH, 'utf-8');
        const factorySettings = JSON.parse(data);
        return NextResponse.json(factorySettings);
    } catch (error) {
        console.error('讀取原廠設定檔案失敗:', error);
        return NextResponse.json(
            { error: '無法讀取原廠設定檔案' },
            { status: 500 }
        );
    }
}
