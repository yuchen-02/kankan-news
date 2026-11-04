// 不碰 DOM 的小工具，方便在 Node 裡測試（test/lib.test.ts）。

/** 摘要在後端資料庫的保留天數（要和 src/pipeline.ts 的 DIGEST_TTL_SECONDS 一致） */
export const DIGEST_RETENTION_DAYS = 21;
export const TAIPEI = Object.freeze({ name: "台北", lat: 25.0375, lon: 121.5637 });
export const FALLBACK_TZ = "Asia/Taipei";
export const TABS = Object.freeze(["tw", "world"]);

/** 取得使用者本機的時區；取不到或不合法時改用台北時間 */
export function resolveTimeZone() {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      new Intl.DateTimeFormat("zh-TW", { timeZone: tz }); // 不合法的時區會在這裡丟錯
      return { tz, fallback: false };
    }
  } catch (e) {
    /* 往下用 fallback */
  }
  return { tz: FALLBACK_TZ, fallback: true };
}

/** 「現在時間」：日期＋星期、時分。時區不合法時退回台北。 */
export function formatClock(date, tz) {
  const fmt = (opts) => {
    try {
      return new Intl.DateTimeFormat("zh-TW", { timeZone: tz, ...opts }).format(date);
    } catch (e) {
      return new Intl.DateTimeFormat("zh-TW", { timeZone: FALLBACK_TZ, ...opts }).format(date);
    }
  };
  // 「11/4 三」：月/日（不補零）＋星期一個字；星期用英文名稱對照，避免各瀏覽器中文格式不同
  const num = (opts) => Number(fmt(opts).replace(/\D/g, ""));
  const weekEn = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
    } catch (e) {
      return new Intl.DateTimeFormat("en-US", { timeZone: FALLBACK_TZ, weekday: "short" }).format(date);
    }
  })();
  const weekZh = { Sun: "日", Mon: "一", Tue: "二", Wed: "三", Thu: "四", Fri: "五", Sat: "六" }[weekEn] || "";
  return {
    dateText: num({ month: "numeric" }) + "/" + num({ day: "numeric" }) + " " + weekZh,
    timeText: fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  };
}

// ── 一天裡的時段（時鐘左邊的圖示）────────────────────

/** 依「小時（0–23）」回傳時段：key 對應 app.js 裡的圖示，label 是螢幕閱讀器／提示文字 */
export function dayPart(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 0;
  if (h < 5) return { key: "night", label: "深夜" };
  if (h < 11) return { key: "morning", label: "早上" };
  if (h < 14) return { key: "noon", label: "中午" };
  if (h < 18) return { key: "afternoon", label: "下午" };
  if (h < 20) return { key: "dusk", label: "傍晚" };
  return { key: "evening", label: "晚上" };
}

// ── 七段顯示器 ────────────────────────────────────

// 七段顯示器每個數字亮哪幾段（a 上、b 右上、c 右下、d 下、e 左下、f 左上、g 中）
export const SEGMENTS_ON = Object.freeze({
  0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg",
  5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg",
});

/** 一個字元要亮的段；":" 或其他字元回傳 null（由畫面另外處理） */
export function segmentsFor(ch) {
  return Object.prototype.hasOwnProperty.call(SEGMENTS_ON, ch) ? SEGMENTS_ON[ch] : null;
}

// ── 天氣的「體感」分級（圖示與文字）──────────────────

/** 氣溫（°C）→ 體感 */
export function tempLevel(t) {
  if (!Number.isFinite(t)) return { key: "none", label: "" };
  if (t <= 10) return { key: "cold", label: "寒冷" };
  if (t <= 17) return { key: "cool", label: "涼爽" };
  if (t <= 25) return { key: "mild", label: "舒適" };
  if (t <= 30) return { key: "warm", label: "溫暖" };
  if (t <= 34) return { key: "hot", label: "炎熱" };
  return { key: "scorching", label: "酷熱" };
}

/** 相對濕度（%）→ 體感 */
export function humidityLevel(h) {
  if (!Number.isFinite(h)) return { key: "none", label: "" };
  if (h < 40) return { key: "dry", label: "乾燥" };
  if (h <= 70) return { key: "mild", label: "舒適" };
  if (h <= 85) return { key: "humid", label: "潮濕" };
  return { key: "veryhumid", label: "很潮濕" };
}

/** 降雨機率（%，可能是 null）→ 程度 */
export function rainLevel(p) {
  if (!Number.isFinite(p)) return { key: "none", label: "" };
  if (p < 20) return { key: "low", label: "不易下雨" };
  if (p < 50) return { key: "mid", label: "可能下雨" };
  if (p < 80) return { key: "high", label: "容易下雨" };
  return { key: "veryhigh", label: "很可能下雨" };
}

// ── 定位後顯示地區名稱 ─────────────────────────────

/** 反向地理編碼（座標 → 地名）。只送到小數第 2 位，和天氣一樣 */
export function reverseGeocodeUrl(lat, lon) {
  const q = new URLSearchParams({ latitude: lat.toFixed(2), longitude: lon.toFixed(2), localityLanguage: "zh" });
  return "https://api.bigdatacloud.net/data/reverse-geocode-client?" + q.toString();
}

/** 取「縣市 + 區」，例如「臺北市 信義區」；兩者相同或缺一個時只顯示有的；都沒有回傳 null */
export function placeNameFromGeocode(j) {
  if (!j || typeof j !== "object") return null;
  const clean = (v) => (typeof v === "string" ? v.trim() : "");
  const city = clean(j.city) || clean(j.principalSubdivision);
  const area = clean(j.locality);
  const parts = [city, area].filter(Boolean);
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.length ? parts.join(" ") : null;
}

/** "MM/DD HH:mm"；不給 tz 就用使用者本機時區 */
export function fmtDateTime(iso, tz) {
  const opts = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (tz) opts.timeZone = tz;
  // 不同瀏覽器的 ICU 版本會用不同的空白字元（例如細空白 U+2009），統一成一般空白
  return new Date(iso).toLocaleString("zh-TW", opts).replace(/\s+/g, " ");
}

export function relativeFromNow(ms, nowMs) {
  const h = Math.round((nowMs - ms) / 36e5);
  if (h < 1) return "不到一小時前";
  if (h < 48) return h + " 小時前";
  return Math.round(h / 24) + " 天前";
}

// ── 時間選單：依「天」分組 ──────────────────────────

const dayKeyOf = (ms, tz) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch (e) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: FALLBACK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  }
};

/**
 * 把摘要清單（每筆要有 generatedAt）依「天」分組，新的天在前、同一天裡新的在前。
 * 回傳 [{ key: "2026-11-05", label: "今天", dateText: "11/5 四", items: [...] }]
 * label：今天／昨天，其他是「11/3 二」。tz 不給就用使用者本機時區。
 */
export function groupByDay(entries, nowMs, tz) {
  const zone = tz || resolveTimeZone().tz;
  const todayKey = dayKeyOf(nowMs, zone);
  const yesterdayKey = dayKeyOf(nowMs - 86400_000, zone);
  const groups = new Map();
  const sorted = [...entries].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  for (const e of sorted) {
    const ms = Date.parse(e.generatedAt);
    if (!Number.isFinite(ms)) continue;
    const key = dayKeyOf(ms, zone);
    if (!groups.has(key)) {
      const [, m, d] = key.split("-").map(Number);
      const wk = formatClock(new Date(ms), zone).dateText.split(" ")[1] || "";
      const dateText = m + "/" + d + " " + wk;
      groups.set(key, { key, label: key === todayKey ? "今天" : key === yesterdayKey ? "昨天" : dateText, dateText, items: [] });
    }
    groups.get(key).items.push(e);
  }
  return [...groups.values()];
}

/** "HH:mm"（使用者本機時區；tz 可指定，測試用） */
export function timeOfDay(iso, tz) {
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (tz) opts.timeZone = tz;
  return new Date(iso).toLocaleTimeString("zh-TW", opts).replace(/\s+/g, " ");
}

/**
 * 摘要時間選單用的名稱：排程是早（07:00）、中（12:00）、晚（18:00），
 * 所以把一天分成 早上／中午／晚上（以及 00:00–04:59 的深夜，給不在排程上的舊資料）。
 * hour 是使用者本機時區的小時（0–23）。
 */
export function slotLabel(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 0;
  if (h < 5) return "深夜";
  if (h < 11) return "早上";
  if (h < 15) return "中午";
  return "晚上";
}

/** 這份摘要（ISO 時間）在使用者本機時區的時段名稱 */
export function slotLabelOf(iso, tz) {
  return slotLabel(parseInt(timeOfDay(iso, tz).slice(0, 2), 10));
}

// ── 主題 ──────────────────────────────────────────

/** 有儲存的選擇就用它，沒有就跟隨使用者本機（作業系統／瀏覽器）的設定 */
export function resolveTheme(stored, systemDark) {
  if (stored === "light" || stored === "dark") return stored;
  return systemDark ? "dark" : "light";
}

export function nextTheme(current) {
  return current === "dark" ? "light" : "dark";
}

// ── 分頁 ──────────────────────────────────────────

export function normalizeTab(v) {
  return TABS.includes(v) ? v : null;
}

/** 網址 hash（#world）優先，其次是上次的選擇，最後預設台灣 */
export function tabFromHash(hash, stored) {
  return normalizeTab((hash || "").replace(/^#/, "")) || normalizeTab(stored) || "tw";
}

// ── 天氣（Open-Meteo） ─────────────────────────────

/** 座標只送到小數第 2 位（約 1 公里），不需要更精準，也少洩漏一點位置 */
export function weatherUrl(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: "temperature_2m,relative_humidity_2m",
    hourly: "precipitation_probability",
    timezone: "auto",
    forecast_days: "2",
  });
  return "https://api.open-meteo.com/v1/forecast?" + q.toString();
}

/** 回傳 { temp, humidity, rain }（rain 可能是 null）；資料不完整回傳 null */
export function parseWeather(j) {
  const c = j && j.current;
  if (!c || typeof c.temperature_2m !== "number" || typeof c.relative_humidity_2m !== "number") return null;

  let rain = null;
  const times = j.hourly && j.hourly.time;
  const probs = j.hourly && j.hourly.precipitation_probability;
  if (Array.isArray(times) && Array.isArray(probs) && typeof c.time === "string") {
    const i = times.indexOf(c.time.slice(0, 13) + ":00"); // 取「現在這個整點」的降雨機率
    const v = i >= 0 ? probs[i] : null;
    if (typeof v === "number" && Number.isFinite(v)) rain = Math.round(v);
  }
  return { temp: Math.round(c.temperature_2m), humidity: Math.round(c.relative_humidity_2m), rain };
}

// ── 標題裡的國家名稱 ────────────────────────────────

// [國碼, 比對用的正規表示式]。別名放在同一個國碼底下，所以會用同一個顏色和國旗。
// 已排除常見的誤判：中國信託／中國時報、韓國瑜、印度洋、南蘇丹、歐洲大陸……
export const COUNTRIES = [
  ["tw", "台灣|臺灣"],
  ["cn", "中國大陸|中國(?!信託|時報|石油|鋼鐵|電視|文化大學)|(?<![洲新])大陸|中共|北京|上海|深圳"],
  ["hk", "香港"],
  ["mo", "澳門"],
  ["us", "美國|華府|華盛頓特區|紐約|洛杉磯|舊金山|白宮"],
  ["jp", "日本|東京|大阪"],
  ["kr", "南韓|韓國(?!瑜)|首爾"],
  ["kp", "北韓|平壤"],
  ["ru", "俄羅斯|俄國|莫斯科|克里姆林宮"],
  ["ua", "烏克蘭|基輔"],
  ["il", "以色列"],
  ["ps", "巴勒斯坦"],
  ["ir", "伊朗|德黑蘭"],
  ["iq", "伊拉克|巴格達"],
  ["sy", "敘利亞|大馬士革"],
  ["lb", "黎巴嫩"],
  ["tr", "土耳其|安卡拉|伊斯坦堡"],
  ["sa", "沙烏地阿拉伯|沙烏地"],
  ["ae", "阿拉伯聯合大公國|阿聯"],
  ["eg", "埃及|開羅"],
  ["sd", "(?<!南)蘇丹"],
  ["za", "南非"],
  ["ng", "奈及利亞"],
  ["ke", "肯亞"],
  ["et", "衣索比亞"],
  ["gb", "英國|倫敦"],
  ["de", "德國|柏林"],
  ["fr", "法國|巴黎"],
  ["it", "義大利|羅馬(?!尼亞)"],
  ["es", "西班牙|馬德里"],
  ["pt", "葡萄牙"],
  ["nl", "荷蘭"],
  ["be", "比利時"],
  ["ch", "瑞士"],
  ["at", "奧地利"],
  ["se", "瑞典"],
  ["no", "挪威"],
  ["dk", "丹麥"],
  ["fi", "芬蘭"],
  ["pl", "波蘭"],
  ["cz", "捷克"],
  ["hu", "匈牙利"],
  ["gr", "希臘"],
  ["ie", "愛爾蘭"],
  ["rs", "塞爾維亞"],
  ["by", "白俄羅斯"],
  ["in", "印度(?!洋|尼西亞)|新德里|德里|孟買"],
  ["id", "印尼|印度尼西亞|雅加達"],
  ["pk", "巴基斯坦|伊斯蘭馬巴德"],
  ["af", "阿富汗|喀布爾"],
  ["bd", "孟加拉"],
  ["np", "尼泊爾"],
  ["lk", "斯里蘭卡"],
  ["ph", "菲律賓|馬尼拉"],
  ["vn", "越南|河內"],
  ["th", "泰國|曼谷"],
  ["my", "馬來西亞|吉隆坡"],
  ["sg", "新加坡"],
  ["mm", "緬甸"],
  ["kh", "柬埔寨"],
  ["la", "寮國"],
  ["au", "澳洲|坎培拉|雪梨"],
  ["nz", "紐西蘭"],
  ["ca", "加拿大|渥太華"],
  ["mx", "墨西哥"],
  ["br", "巴西(?!利亞)|巴西利亞"],
  ["ar", "阿根廷"],
  ["cl", "智利"],
  ["co", "哥倫比亞"],
  ["ve", "委內瑞拉"],
  ["cu", "古巴"],
  ["pe", "秘魯|祕魯"],
].map(([code, src]) => ({ code, re: new RegExp(src, "g") }));

export const COUNTRY_TONES = 12; // style.css 的 --tone-0 … --tone-11

// 常見國家先各自指定一個顏色，其餘用國碼算出來；同一國碼永遠是同一個顏色。
const TONE_PINNED = { tw: 0, cn: 1, us: 2, jp: 3, kr: 4, ru: 5, ua: 6, il: 7, gb: 8, de: 9, fr: 10, in: 11 };

export function toneOf(code) {
  if (code in TONE_PINNED) return TONE_PINNED[code];
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % COUNTRY_TONES;
}

/**
 * 把標題切成片段：{ text } 是一般文字，{ text, code } 是國家名稱。
 * 同一個國家的別名算同一個國碼。skip 是不要標記的國碼（例如台灣分頁裡的台灣）。
 * 回傳 { parts, codes }，codes 依在標題裡第一次出現的順序、不重複。
 */
export function markCountries(headline, skip = []) {
  const hits = [];
  for (const { code, re } of COUNTRIES) {
    if (skip.includes(code)) continue;
    re.lastIndex = 0;
    for (const m of headline.matchAll(re)) hits.push({ start: m.index, end: m.index + m[0].length, code });
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);

  const kept = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue; // 和前一個重疊，保留較早／較長的
    kept.push(h);
    cursor = h.end;
  }

  const parts = [];
  const codes = [];
  let pos = 0;
  for (const h of kept) {
    if (h.start > pos) parts.push({ text: headline.slice(pos, h.start) });
    parts.push({ text: headline.slice(h.start, h.end), code: h.code });
    if (!codes.includes(h.code)) codes.push(h.code);
    pos = h.end;
  }
  if (pos < headline.length) parts.push({ text: headline.slice(pos) });
  return { parts, codes };
}

export function flagUrl(code) {
  return "https://flagcdn.com/w40/" + code + ".png";
}
