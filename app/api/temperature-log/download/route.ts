import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

// 允許下載的檔案列表（安全性檢查）
const ALLOWED_FILES = [
  'Sunday.txt',
  'Monday.txt',
  'Tuesday.txt',
  'Wednesday.txt',
  'Thursday.txt',
  'Friday.txt',
  'Saturday.txt'
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get('file');
    
    console.log(`📥 請求下載溫度記錄檔案: ${filename}`);
    
    // 驗證檔案名稱
    if (!filename) {
      return NextResponse.json({
        success: false,
        error: '缺少檔案名稱參數',
        message: '請提供要下載的檔案名稱'
      }, { status: 400 });
    }
    
    // 安全性檢查：確保只能下載允許的檔案
    if (!ALLOWED_FILES.includes(filename)) {
      return NextResponse.json({
        success: false,
        error: '檔案名稱無效',
        message: '只能下載星期溫度記錄檔案',
        allowedFiles: ALLOWED_FILES
      }, { status: 403 });
    }
    
    const filePath = path.join(DATA_DIR, filename);
    
    // 檢查檔案是否存在
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json({
        success: false,
        error: '檔案不存在',
        message: `找不到檔案: ${filename}`,
        suggestion: '請確認檔案名稱是否正確，或檔案尚未建立'
      }, { status: 404 });
    }
    
    // 讀取檔案內容
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const fileStats = await fs.stat(filePath);
    
    // 準備下載回應
    const response = new NextResponse(fileContent);
    
    // 設定下載標頭
    response.headers.set('Content-Type', 'text/plain; charset=utf-8');
    response.headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    response.headers.set('Content-Length', fileStats.size.toString());
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
    
    console.log(`✅ 檔案下載準備完成: ${filename} (${fileStats.size} bytes)`);
    
    return response;
    
  } catch (error) {
    console.error('❌ 處理檔案下載請求失敗:', error);
    
    return NextResponse.json({
      success: false,
      error: '下載失敗',
      message: '伺服器處理下載請求時發生錯誤',
      details: error instanceof Error ? error.message : '未知錯誤'
    }, { status: 500 });
  }
}