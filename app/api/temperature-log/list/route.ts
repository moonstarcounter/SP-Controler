import { NextResponse } from 'next/server';
import { getAvailableLogFiles } from '@/lib/temperature-logger';

export async function GET() {
  try {
    console.log('📋 請求溫度記錄檔案列表');
    
    const files = await getAvailableLogFiles();
    
    const fileList = files.map(filename => ({
      name: filename,
      displayName: filename.replace('.txt', ''),
      dayOfWeek: filename.replace('.txt', ''),
      url: `/api/temperature-log/download?file=${encodeURIComponent(filename)}`
    }));
    
    return NextResponse.json({
      success: true,
      files: fileList,
      count: files.length,
      message: `找到 ${files.length} 個溫度記錄檔案`
    });
    
  } catch (error) {
    console.error('❌ 獲取溫度記錄檔案列表失敗:', error);
    
    return NextResponse.json({
      success: false,
      files: [],
      count: 0,
      error: '無法讀取溫度記錄檔案列表',
      message: '請檢查伺服器狀態或檔案系統權限'
    }, { status: 500 });
  }
}