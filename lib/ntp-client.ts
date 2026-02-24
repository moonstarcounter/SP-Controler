/**
 * NTP 時間同步客戶端
 * 用於從 NTP 伺服器獲取準確的時間，支援溫度記錄的時間戳記
 */

// NTP 伺服器列表（使用公共 NTP 伺服器）
const NTP_SERVERS = [
  'time.google.com',        // Google 公共 NTP
  'time.windows.com',       // Microsoft 公共 NTP
  'time.apple.com',         // Apple 公共 NTP
  'pool.ntp.org',           // NTP 池項目
  'time.cloudflare.com'     // Cloudflare 公共 NTP
];

// 快取最後一次同步的時間，避免頻繁請求
let lastSyncTime: number | null = null;
let timeOffset = 0; // 本地時間與 NTP 時間的偏移量（毫秒）

/**
 * 從 NTP 伺服器獲取當前時間
 * @returns 返回 Date 對象，如果失敗則返回本地時間
 */
export async function getNTPTime(): Promise<Date> {
  try {
    // 如果最近 5 分鐘內同步過，使用快取
    if (lastSyncTime && (Date.now() - lastSyncTime) < 5 * 60 * 1000) {
      return new Date(Date.now() + timeOffset);
    }

    console.log('🕒 正在從 NTP 伺服器同步時間...');
    
    // 嘗試從多個 NTP 伺服器獲取時間
    for (const server of NTP_SERVERS) {
      try {
        const ntpTime = await fetchTimeFromServer(server);
        if (ntpTime) {
          // 計算偏移量
          const localTime = Date.now();
          timeOffset = ntpTime.getTime() - localTime;
          lastSyncTime = localTime;
          
          console.log(`✅ 時間同步成功 (${server}): ${formatDateTime(ntpTime)}`);
          console.log(`📊 時間偏移: ${timeOffset}ms`);
          
          return ntpTime;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  從 ${server} 同步時間失敗:`, errorMessage);
      }
    }
    
    // 所有伺服器都失敗，使用本地時間
    console.warn('⚠️  所有 NTP 伺服器同步失敗，使用本地時間');
    return new Date();
    
  } catch (error) {
    console.error('❌ NTP 時間同步錯誤:', error);
    return new Date(); // 返回本地時間作為備用
  }
}

/**
 * 從單個 NTP 伺服器獲取時間
 */
async function fetchTimeFromServer(server: string): Promise<Date | null> {
  return new Promise((resolve, reject) => {
    // 使用 HTTP 請求獲取時間（更簡單可靠）
    // 許多公共 NTP 伺服器也提供 HTTP API
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    // 嘗試使用 HTTP 日期頭部
    fetch(`http://${server}`, { 
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store'
    })
      .then(response => {
        clearTimeout(timeoutId);
        const dateHeader = response.headers.get('date');
        if (dateHeader) {
          const serverTime = new Date(dateHeader);
          if (isValidDate(serverTime)) {
            resolve(serverTime);
          } else {
            reject(new Error('無效的日期格式'));
          }
        } else {
          reject(new Error('未找到日期頭部'));
        }
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

/**
 * 格式化日期時間為 "YYYY-MM-DD HH:MM" 格式
 */
export function formatDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * 格式化日期時間為溫度記錄格式 "YYYY-MM-DD HH:MM       "
 */
export function formatTemperatureTimestamp(date: Date): string {
  const formatted = formatDateTime(date);
  // 固定寬度格式，確保對齊
  return `${formatted}       `;
}

/**
 * 獲取星期幾的英文名稱
 */
export function getDayOfWeek(date: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[date.getDay()];
}

/**
 * 獲取星期幾的檔案名稱
 */
export function getDayOfWeekFileName(date: Date): string {
  const dayName = getDayOfWeek(date);
  return `${dayName}.txt`;
}

/**
 * 檢查是否是有效日期
 */
function isValidDate(date: Date): boolean {
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * 初始化時間同步（應用啟動時呼叫）
 */
export async function initTimeSync(): Promise<void> {
  try {
    const ntpTime = await getNTPTime();
    console.log(`🕒 系統時間已初始化: ${formatDateTime(ntpTime)}`);
  } catch (error) {
    console.error('❌ 時間同步初始化失敗:', error);
  }
}

/**
 * 定期同步時間（每小時同步一次）
 */
export function startPeriodicTimeSync(intervalMinutes: number = 60): void {
  setInterval(async () => {
    try {
      await getNTPTime();
    } catch (error) {
      console.error('❌ 定期時間同步失敗:', error);
    }
  }, intervalMinutes * 60 * 1000);
  
  console.log(`🔄 已啟動定期時間同步（每 ${intervalMinutes} 分鐘）`);
}

/**
 * 獲取當前時間的格式化字符串（使用 NTP 時間）
 */
export async function getCurrentFormattedTime(): Promise<string> {
  const date = await getNTPTime();
  return formatDateTime(date);
}

/**
 * 檢查是否是同一天（用於檔案管理）
 */
export function isSameDay(date1: Date, date2: Date): boolean {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}