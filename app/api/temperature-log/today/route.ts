import { NextResponse } from 'next/server';
import { getTodayTemperatureRecords } from '@/lib/temperature-logger';
import { getCurrentFormattedTime } from '@/lib/ntp-client';

export async function GET() {
  try {
    console.log('📊 請求今日溫度記錄');
    
    // 獲取當前時間
    const currentTime = await getCurrentFormattedTime();
    
    // 獲取今日的溫度記錄
    const records = await getTodayTemperatureRecords();
    
    // 格式化記錄數據
    const formattedRecords = records.map(record => {
      // 記錄格式: "2026-01-07 13:35       25.2°C"
      const parts = record.trim().split(/\s+/);
      const timestamp = parts.slice(0, 2).join(' ');
      const temperature = parts.slice(2).join(' ');
      
      return {
        raw: record.trim(),
        timestamp,
        temperature,
        time: parts[1], // 只取時間部分
        value: parseFloat(temperature.replace('°C', '')),
        formatted: `${timestamp} - ${temperature}`
      };
    });
    
    // 計算統計數據
    const temperatures = formattedRecords
      .filter(record => !isNaN(record.value))
      .map(record => record.value);
    
    const stats = {
      count: records.length,
      average: temperatures.length > 0 ? 
        (temperatures.reduce((a, b) => a + b, 0) / temperatures.length).toFixed(1) : 0,
      min: temperatures.length > 0 ? Math.min(...temperatures).toFixed(1) : 0,
      max: temperatures.length > 0 ? Math.max(...temperatures).toFixed(1) : 0,
      latest: temperatures.length > 0 ? temperatures[temperatures.length - 1].toFixed(1) : 0
    };
    
    return NextResponse.json({
      success: true,
      currentTime,
      records: formattedRecords,
      rawRecords: records,
      stats,
      summary: {
        totalRecords: records.length,
        dateRange: currentTime.split(' ')[0], // 只取日期部分
        timeRange: formattedRecords.length > 0 ? 
          `${formattedRecords[0].time} ~ ${formattedRecords[formattedRecords.length - 1].time}` : 
          '無記錄'
      },
      message: `找到 ${records.length} 筆今日溫度記錄`
    });
    
  } catch (error) {
    console.error('❌ 獲取今日溫度記錄失敗:', error);
    
    return NextResponse.json({
      success: false,
      currentTime: new Date().toISOString(),
      records: [],
      rawRecords: [],
      stats: {
        count: 0,
        average: 0,
        min: 0,
        max: 0,
        latest: 0
      },
      error: '無法讀取今日溫度記錄',
      message: '請檢查溫度記錄服務是否正常運作'
    }, { status: 500 });
  }
}