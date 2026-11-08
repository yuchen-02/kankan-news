/**
 * 台股：純函式（時間、時段判斷、解析證交所資料）。不碰網路與儲存空間，方便測試。
 *
 * 資料來源：
 * - 盤中與收盤價：證交所「基本市況報導」MIS（mis.twse.com.tw）。一次最多約 140 檔（實測 150 檔起回「參數不足」）。
 * - 上市股票清單（代號＋名稱）：證交所 OpenAPI STOCK_DAY_ALL。
 * - 加權指數收盤值：證交所 OpenAPI MI_INDEX（MIS 的指數值收盤後不一定是最終值）。
 */

/** 盤中推送的連線上限：全站總數、單一 IP */
export const LIVE_MAX_SOCKETS = 200;
export const LIVE_MAX_PER_IP = 5;
export const liveSlotsFull = (total: number, fromIp: number): boolean => total >= LIVE_MAX_SOCKETS || fromIp >= LIVE_MAX_PER_IP;

/** 加權指數的 MIS 代號 */
export const INDEX_CH = "tse_t00.tw";
/** 一次 MIS 請求帶幾檔（實測 140 檔可以，留一點餘裕） */
export const MIS_BATCH = 135;

/** [代號, 名稱] */
export type StockName = [code: string, name: string];
/** [代號, 現價, 漲跌, 漲跌幅%]；還沒成交時價格類欄位是 null */
export type LiveQuote = [code: string, price: number | null, change: number | null, pct: number | null];
/** [代號, 名稱, 現價, 漲跌, 漲跌幅%] */
export type CloseQuote = [code: string, name: string, price: number | null, change: number | null, pct: number | null];

export interface IndexQuote {
  value: number | null;
  change: number | null;
  pct: number | null;
}

/** 一天的收盤資料（存在 KV） */
export interface CloseSnapshot {
  /** 交易日 YYYY-MM-DD（台北） */
  date: string;
  fetchedAt: string;
  index: IndexQuote | null;
  quotes: CloseQuote[];
}

/**
 * 頁面要顯示哪一種狀態：
 * pre＝還沒開盤（顯示上一個交易日收盤）、live＝盤中、after＝已收盤但收盤價還沒到抓取時間（顯示最後成交價）、
 * fetching＝正在抓收盤價、failed＝兩次都沒抓到（顯示最後成交價）、closed＝顯示收盤價（含週末、休市）。
 */
export type Phase = "pre" | "live" | "after" | "fetching" | "failed" | "closed";

/** 每天收盤價的抓取狀態（存在 KV） */
export interface CloseStatus {
  /** 台北日期 YYYY-MM-DD */
  date: string;
  state: "ok" | "retry" | "failed" | "holiday";
  at: string;
  error?: string;
}

// ── 時間（全部用台北時間；台灣沒有日光節約，固定 UTC+8）────────

const TPE_OFFSET_MS = 8 * 3600_000;
export const OPEN_MIN = 9 * 60; // 09:00
export const CLOSE_MIN = 13 * 60 + 30; // 13:30
export const FETCH_MIN = 14 * 60 + 30; // 14:30 第一次抓收盤價
export const RETRY_MIN = 14 * 60 + 40; // 14:40 再抓一次
/** 超過這個時間今天的收盤價還沒進來，就當作失敗（排程沒跑或兩次都失敗） */
export const GIVE_UP_MIN = 14 * 60 + 50;

export interface TaipeiTime {
  /** YYYY-MM-DD */
  date: string;
  /** 0＝週日 … 6＝週六 */
  weekday: number;
  /** 當天第幾分鐘（0–1439） */
  minutes: number;
  /** 當天第幾秒 */
  seconds: number;
}

export function taipeiTime(nowMs: number): TaipeiTime {
  const d = new Date(nowMs + TPE_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  const seconds = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return { date, weekday: d.getUTCDay(), minutes: Math.floor(seconds / 60), seconds };
}

/** 台北某天 hh:mm 的 UTC 毫秒 */
export function taipeiMs(date: string, minutes: number): number {
  return Date.parse(date + "T00:00:00Z") - TPE_OFFSET_MS + minutes * 60_000;
}

const isWeekday = (t: TaipeiTime) => t.weekday >= 1 && t.weekday <= 5;

/** 依時鐘判斷是不是盤中（不知道國定假日；休市日由 MIS 回傳的日期判斷） */
export function isMarketHours(nowMs: number): boolean {
  const t = taipeiTime(nowMs);
  return isWeekday(t) && t.minutes >= OPEN_MIN && t.minutes < CLOSE_MIN;
}

/**
 * 依時間與今天收盤價的抓取狀態，決定頁面狀態，並回傳下一次狀態可能改變的時間（頁面到時候再問一次）。
 * status 是 KV 裡的抓取狀態（不是今天的就當作還沒抓）。
 */
export function phaseAt(nowMs: number, status: CloseStatus | null): { phase: Phase; nextCheckAt: number | null } {
  const t = taipeiTime(nowMs);
  const at = (m: number) => taipeiMs(t.date, m);
  if (!isWeekday(t)) return { phase: "closed", nextCheckAt: null };
  const today = status && status.date === t.date ? status : null;
  // 今天確定休市（排程看到 MIS 的日期不是今天）
  if (today?.state === "holiday") return { phase: "closed", nextCheckAt: null };
  if (t.minutes < OPEN_MIN) return { phase: "pre", nextCheckAt: at(OPEN_MIN) };
  if (t.minutes < CLOSE_MIN) return { phase: "live", nextCheckAt: at(CLOSE_MIN) };
  if (t.minutes < FETCH_MIN) return { phase: "after", nextCheckAt: at(FETCH_MIN) };
  if (today?.state === "ok") return { phase: "closed", nextCheckAt: null };
  if (today?.state === "failed") return { phase: "failed", nextCheckAt: null };
  if (t.minutes < GIVE_UP_MIN) return { phase: "fetching", nextCheckAt: Math.min(nowMs + 60_000, at(GIVE_UP_MIN)) };
  return { phase: "failed", nextCheckAt: null };
}

// ── 數字 ────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2135.0000" → 2135；"-"、空字串、0 → null */
export function num(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 由現價與昨收算出 [漲跌, 漲跌幅%]；缺任何一個就是 null */
export function changeOf(price: number | null, prev: number | null): [number | null, number | null] {
  if (price === null || prev === null) return [null, null];
  const ch = round2(price - prev);
  return [ch, round2((ch / prev) * 100)];
}

// ── 股票清單 ────────────────────────────────────────

/** 一般股票（4 碼數字）與 ETF（00 開頭）；權證、受益憑證等其他商品不列 */
export function isStockCode(code: string): boolean {
  return /^\d{4}$/.test(code) || /^00\d{3,4}[A-Z]?$/.test(code);
}

/** STOCK_DAY_ALL → 上市股票清單（依代號排序、去掉重複） */
export function parseStockList(rows: unknown): StockName[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Map<string, string>();
  for (const r of rows) {
    const code = typeof r?.Code === "string" ? r.Code.trim() : "";
    const name = typeof r?.Name === "string" ? r.Name.trim() : "";
    if (isStockCode(code) && name && !seen.has(code)) seen.set(code, name);
  }
  return [...seen].sort((a, b) => cmpCode(a[0], b[0]));
}

/** 代號排序：一般字串排序（"0050" < "1101" < "2330"），跟證交所列表一致 */
export function cmpCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── MIS ─────────────────────────────────────────────

export function misUrl(chs: string[]): string {
  return "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + encodeURIComponent(chs.join("|")) + "&json=1&delay=0";
}

export const chOf = (code: string) => `tse_${code}.tw`;

/** 把代號清單切成每批最多 size 檔；加權指數放在第一批 */
export function misBatches(codes: string[], size = MIS_BATCH): string[][] {
  const chs = [INDEX_CH, ...codes.map(chOf)];
  const out: string[][] = [];
  for (let i = 0; i < chs.length; i += size) out.push(chs.slice(i, i + size));
  return out;
}

export interface MisRow {
  code: string;
  name: string;
  /** 最新成交價（沒有就是 null） */
  price: number | null;
  /** 昨收 */
  prev: number | null;
  /** 資料日期 YYYY-MM-DD */
  date: string | null;
  /** 資料時間 HH:MM:SS */
  time: string | null;
}

/**
 * MIS 的 msgArray → 每檔一列。z 是最新成交價；剛好這一刻沒有成交時 z 會是 "-"，改用 trade.z（最後一筆成交）。
 * 查不到的代號（c 是空字串）會略過。
 */
export function parseMis(json: unknown): MisRow[] {
  const arr = (json as { msgArray?: unknown })?.msgArray;
  if (!Array.isArray(arr)) return [];
  const out: MisRow[] = [];
  for (const m of arr) {
    const code = typeof m?.c === "string" ? m.c : "";
    if (!code) continue;
    const d = typeof m.d === "string" && /^\d{8}$/.test(m.d) ? `${m.d.slice(0, 4)}-${m.d.slice(4, 6)}-${m.d.slice(6, 8)}` : null;
    out.push({
      code,
      name: typeof m.n === "string" ? m.n : "",
      price: num(m.z) ?? num(m?.trade?.z),
      prev: num(m.y),
      date: d,
      time: typeof m.t === "string" ? m.t : typeof m["%"] === "string" ? m["%"] : null,
    });
  }
  return out;
}

/** MI_INDEX（OpenAPI）→ 加權指數收盤值；日期是民國年 "1151106" */
export function parseIndexClose(rows: unknown): { date: string; quote: IndexQuote } | null {
  if (!Array.isArray(rows)) return null;
  const r = rows.find((x) => x?.["指數"] === "發行量加權股價指數");
  if (!r) return null;
  const date = rocDate(r["日期"]);
  const value = num(r["收盤指數"]);
  const pts = num(r["漲跌點數"]);
  const sign = r["漲跌"] === "-" ? -1 : 1;
  const pct = Number(String(r["漲跌百分比"] ?? "").replace(/,/g, ""));
  if (!date || value === null) return null;
  return { date, quote: { value, change: pts === null ? 0 : round2(sign * pts), pct: Number.isFinite(pct) ? round2(pct) : null } };
}

/** 民國年 "1151106" → "2026-11-06" */
export function rocDate(v: unknown): string | null {
  const s = String(v ?? "");
  const m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

/** 盤中資料：加權指數＋每檔股票 */
export interface LiveSnapshot {
  /** 資料日期（MIS 回傳的） */
  date: string | null;
  /** 最新一筆資料時間 HH:MM:SS */
  time: string | null;
  index: IndexQuote | null;
  quotes: LiveQuote[];
}

/**
 * 多批 MIS 結果 → 盤中快照。prevPrices：上一次的價格，這一次某檔剛好抓不到成交價時沿用，避免畫面閃成「—」。
 */
export function buildLive(rows: MisRow[], prevPrices?: Map<string, number | null>): LiveSnapshot {
  let index: IndexQuote | null = null;
  let date: string | null = null;
  let time: string | null = null;
  const quotes: LiveQuote[] = [];
  for (const r of rows) {
    if (r.date && (!date || r.date > date)) date = r.date;
    if (r.code === "t00") {
      const [change, pct] = changeOf(r.price, r.prev);
      index = { value: r.price, change, pct };
      continue;
    }
    if (r.time && (!time || r.time > time)) time = r.time;
    const price = r.price ?? prevPrices?.get(r.code) ?? null;
    const [change, pct] = changeOf(price, r.prev);
    quotes.push([r.code, price, change, pct]);
  }
  quotes.sort((a, b) => cmpCode(a[0], b[0]));
  return { date, time, index, quotes };
}

/** 兩次盤中資料的差異：只送有變的那幾檔，減少每 5 秒推送的資料量 */
export function diffQuotes(prev: Map<string, LiveQuote>, next: LiveQuote[]): LiveQuote[] {
  const out: LiveQuote[] = [];
  for (const q of next) {
    const p = prev.get(q[0]);
    if (!p || p[1] !== q[1] || p[2] !== q[2] || p[3] !== q[3]) out.push(q);
  }
  return out;
}
