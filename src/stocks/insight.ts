/**
 * 台股收盤分析：每個交易日 14:50 產生一次。
 *
 * 頁面上的指數與家數由前端依數字組句；AI 只寫下一段評論，資料來源是當天行情、連漲連跌天數與新聞標題。
 * AI 的文字要通過 validateInsight 才會顯示，否則那天只顯示數字與排行。
 */
import { pickTextModel, type TextModel } from "../summarizers/index.ts";
import type { Digest, DigestIndexEntry, Env } from "../types.ts";
import { cmpCode, taipeiTime, type CloseQuote, type CloseSnapshot, type IndexQuote, type VolumeRank } from "./market.ts";
import { CLOSE_TTL_SECONDS, getClose, getDays } from "./store.ts";

const TOP_N = 5;
const STREAK_N = 3;
const MIN_STREAK = 3;
/** 連續紀錄接不上時，最多往回讀幾天的收盤資料重算 */
const STREAK_REBUILD_DAYS = 10;
const MAX_HEADLINES = 40;
const MAX_TOKENS = 500;
const ATTEMPTS = 4;

/** 漲跌幅排行的一列：[代號, 名稱, 收盤價, 漲跌幅%] */
export type RankRow = [code: string, name: string, price: number | null, pct: number | null];
/** 連漲連跌的一列：[代號, 名稱, 連續天數, 今日漲跌幅%] */
export type StreakRow = [code: string, name: string, days: number, pct: number | null];

/** 每檔的連續天數：正數＝連漲、負數＝連跌、0＝平盤或沒成交 */
export interface Streaks {
  date: string;
  index: number;
  stocks: Record<string, number>;
}

export interface MarketFacts {
  date: string;
  index: IndexQuote | null;
  breadth: { up: number; down: number; flat: number; none: number };
  gainers: RankRow[];
  losers: RankRow[];
  volumeEtf: VolumeRank[];
  volumeStock: VolumeRank[];
  streaks: { index: number; up: StreakRow[]; down: StreakRow[] };
}

export interface MarketInsight extends MarketFacts {
  generatedAt: string;
  /** AI 寫的評論；模型失敗或沒通過檢查時是 null */
  text: string | null;
  model: string | null;
}

const insightKey = (date: string) => `stocks:insight:${date}`;
const STREAKS_KEY = "stocks:streaks";
export const getInsight = (kv: KVNamespace, date: string) => kv.get<MarketInsight>(insightKey(date), "json");

// ── 連漲連跌 ─────────────────────────────────────────

function nextStreak(prev: number, change: number | null): number {
  if (!change) return 0;
  const sign = change > 0 ? 1 : -1;
  return Math.sign(prev) === sign ? prev + sign : sign;
}

/** 前一個交易日的紀錄 ＋ 當天收盤 → 當天的紀錄 */
export function advanceStreaks(prev: Streaks | null, snap: CloseSnapshot): Streaks {
  const stocks: Record<string, number> = {};
  for (const q of snap.quotes) stocks[q[0]] = nextStreak(prev?.stocks[q[0]] ?? 0, q[3]);
  return { date: snap.date, index: nextStreak(prev?.index ?? 0, snap.index?.change ?? null), stocks };
}

async function loadStreaks(kv: KVNamespace, snap: CloseSnapshot): Promise<Streaks> {
  const stored = await kv.get<Streaks>(STREAKS_KEY, "json");
  if (stored?.date === snap.date) return stored;
  const days = await getDays(kv);
  const at = days.indexOf(snap.date);
  let streaks: Streaks;
  if (stored && at !== -1 && days[at + 1] === stored.date) {
    streaks = advanceStreaks(stored, snap);
  } else {
    // 第一次，或中間有缺：由舊到新重算手上有的幾天
    const older = at === -1 ? [] : days.slice(at + 1, at + STREAK_REBUILD_DAYS).reverse();
    const snaps = await Promise.all(older.map((d) => getClose(kv, d)));
    let cur: Streaks | null = null;
    for (const s of snaps) if (s) cur = advanceStreaks(cur, s);
    streaks = advanceStreaks(cur, snap);
  }
  await kv.put(STREAKS_KEY, JSON.stringify(streaks));
  return streaks;
}

function longestStreaks(snap: CloseSnapshot, streaks: Streaks, sign: 1 | -1): StreakRow[] {
  const out: StreakRow[] = [];
  for (const q of snap.quotes) {
    const days = (streaks.stocks[q[0]] ?? 0) * sign;
    if (days >= MIN_STREAK) out.push([q[0], q[1], days, q[4]]);
  }
  // 天數一樣時，今天漲跌幅較大的排前面
  return out.sort((a, b) => b[2] - a[2] || Math.abs(b[3] ?? 0) - Math.abs(a[3] ?? 0) || cmpCode(a[0], b[0])).slice(0, STREAK_N);
}

// ── 統計 ─────────────────────────────────────────────

const toRank = (q: CloseQuote): RankRow => [q[0], q[1], q[2], q[4]];

/** 收盤資料 → 給 AI 和頁面用的統計 */
export function buildFacts(snap: CloseSnapshot, streaks: Streaks | null = null): MarketFacts {
  const breadth = { up: 0, down: 0, flat: 0, none: 0 };
  for (const q of snap.quotes) {
    if (q[3] === null) breadth.none++;
    else if (q[3] > 0) breadth.up++;
    else if (q[3] < 0) breadth.down++;
    else breadth.flat++;
  }
  const traded = snap.quotes.filter((q) => q[4] !== null);
  const pct = (q: CloseQuote) => q[4] as number;
  const gainers = traded.filter((q) => pct(q) > 0).sort((a, b) => pct(b) - pct(a) || cmpCode(a[0], b[0]));
  const losers = traded.filter((q) => pct(q) < 0).sort((a, b) => pct(a) - pct(b) || cmpCode(a[0], b[0]));
  return {
    date: snap.date,
    index: snap.index,
    breadth,
    gainers: gainers.slice(0, TOP_N).map(toRank),
    losers: losers.slice(0, TOP_N).map(toRank),
    volumeEtf: snap.volumeEtf ?? [],
    volumeStock: snap.volumeStock ?? [],
    streaks: {
      index: streaks?.index ?? 0,
      up: streaks ? longestStreaks(snap, streaks, 1) : [],
      down: streaks ? longestStreaks(snap, streaks, -1) : [],
    },
  };
}

// ── 給 AI 的內容 ─────────────────────────────────────

const FORBIDDEN = ["建議", "買進", "買入", "賣出", "加碼", "減碼", "預期", "預估", "預計", "後市", "看好", "看淡", "因為", "由於", "導致", "造成", "帶動", "拖累", "受惠", "受到", "反映", "利多", "利空", "可能", "勢必", "氣勢", "旺盛", "強勁", "疲弱", "樂觀", "悲觀", "股價產生"];

export const INSIGHT_SYSTEM = `你是台股盤後評論員，用繁體中文（台灣慣用詞彙）依我提供的資料寫一段客觀評論。

規則：
1. 寫 2 到 4 句，總長不超過 120 字，只輸出這段文字，不要標題或條列。
2. 指數收盤、漲跌與各家數已經另外顯示，不要重複這些數字，也不要逐一念排行名單。
3. 從數字找值得注意的現象，例如連漲連跌天數、上漲與下跌家數的比例、ETF 與個股成交的差異。數字照抄，不可四捨五入或自己計算。
4. 新聞最多提一則，而且只能選央行、利率、匯率、物價、貿易、產業政策這類和整體市場有關的標題，寫成「今日新聞提到（標題裡的事），可留意後續影響」。只能用標題裡有的內容，不可捏造，不可說它是今天漲跌的原因，也不可推測對個別公司或股價的影響。人物私事、八卦、社會事件一律不提；沒有合適的就完全不要提新聞。
5. 沒有連漲連跌資料（顯示「無」）時，不要提連續天數。
6. 不預測漲跌，不給買賣建議，只陳述事實，不加形容市場情緒的字眼。不可使用這些詞：${FORBIDDEN.join("、")}。`;

const streakText = (n: number) => (n > 0 ? `連漲 ${n} 天` : n < 0 ? `連跌 ${-n} 天` : "今日平盤");

export function buildInsightPrompt(f: MarketFacts, headlines: string[] = []): string {
  const i = f.index;
  const ratio = f.breadth.down > 0 ? Math.round((f.breadth.up / f.breadth.down) * 100) / 100 : null;
  const rank = (rows: RankRow[]) => rows.map((r) => `${r[1]}（${r[0]}）：漲跌幅 ${r[3] ?? "無"}%`).join("\n") || "無";
  const volume = (rows: VolumeRank[]) => rows.map((r) => `${r[1]}（${r[0]}）：${r[2]} 張，漲跌幅 ${r[3] ?? "無"}%`).join("\n") || "無";
  const streak = (rows: StreakRow[], word: string) => rows.map((r) => `${r[1]}（${r[0]}）：${word} ${r[2]} 天，今日漲跌幅 ${r[3] ?? "無"}%`).join("\n") || "無";
  return `日期：${f.date}
加權指數：收盤 ${i?.value ?? "無"}，漲跌 ${i?.change ?? "無"} 點，漲跌幅 ${i?.pct ?? "無"}%，${streakText(f.streaks.index)}
家數：上漲 ${f.breadth.up}，下跌 ${f.breadth.down}，平盤 ${f.breadth.flat}，沒有成交 ${f.breadth.none}${ratio === null ? "" : `；上漲家數是下跌的 ${ratio} 倍`}

連漲最久：
${streak(f.streaks.up, "連漲")}

連跌最久：
${streak(f.streaks.down, "連跌")}

漲幅前段：
${rank(f.gainers)}

跌幅前段：
${rank(f.losers)}

ETF 成交量前段：
${volume(f.volumeEtf)}

個股成交量前段：
${volume(f.volumeStock)}

今日新聞標題：
${headlines.map((h) => `- ${h}`).join("\n") || "無"}`;
}

/** 輸入裡出現過的所有數字（取絕對值），文字裡的數字都要在這裡面 */
function allowedNumbers(f: MarketFacts, headlines: string[]): Set<number> {
  const out = new Set<number>();
  for (const m of buildInsightPrompt(f, headlines).match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(m));
  return out;
}

/** 提到新聞或事件的句子，內容至少要和某個標題有連續 3 個字相同，避免捏造事件 */
function mentionsKnownNews(sentence: string, headlines: string[]): boolean {
  const body = sentence.replace(/今日|今天|新聞|提到|報導|事件|政策|可留意|可注意|留意|注意|後續|影響|相關/g, "\n");
  for (let i = 0; i + 3 <= body.length; i++) {
    const part = body.slice(i, i + 3);
    if (!/[\s，、。；：]/.test(part) && headlines.some((h) => h.includes(part))) return true;
  }
  return false;
}

export function cleanInsightText(raw: string): string {
  return raw.replace(/```[a-z]*/gi, "").replace(/\s*\n+\s*/g, "").trim();
}

/** 檢查模型寫的評論；沒問題回傳 null，否則回傳原因（重試時會告訴模型） */
export function validateInsight(text: string, f: MarketFacts, headlines: string[] = []): string | null {
  if (text.length < 20) return "內容太短";
  if (text.length > 240) return "內容太長，總長不可超過 120 字";
  const word = FORBIDDEN.find((w) => text.includes(w));
  if (word) return `不可使用「${word}」`;
  const allowed = allowedNumbers(f, headlines);
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(Number(m.replace(/,/g, "")))) return `數字 ${m} 不在提供的資料裡，數字要照抄`;
  }
  for (const s of text.split(/[。！？]/)) {
    if (/新聞|政策|事件|留意|注意/.test(s) && !mentionsKnownNews(s, headlines)) return "提到的新聞或事件要來自提供的標題";
  }
  return null;
}

async function writeInsight(f: MarketFacts, headlines: string[], model: TextModel): Promise<string | null> {
  const user = buildInsightPrompt(f, headlines);
  let note = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const text = cleanInsightText(await model.text(INSIGHT_SYSTEM, user + note, MAX_TOKENS));
      const problem = validateInsight(text, f, headlines);
      if (!problem) return text;
      console.error("insight rejected:", problem);
      note = `\n\n注意：上一次的輸出有問題：${problem}。請重寫。`;
    } catch (e) {
      console.error("insight model failed:", e instanceof Error ? e.message : e);
    }
  }
  return null;
}

// ── 新聞標題 ─────────────────────────────────────────

/** 當天各期摘要的標題（新的一期在前、去重）。舊的摘要沒有 allHeadlines，就用顯示中的新聞 */
export async function collectHeadlines(kv: KVNamespace, date: string): Promise<string[]> {
  const index = (await kv.get<DigestIndexEntry[]>("index", "json")) ?? [];
  const entries = index.filter((e) => taipeiTime(Date.parse(e.generatedAt)).date === date);
  const digests = await Promise.all(entries.map((e) => kv.get<Digest>(`digest:${e.id}`, "json")));
  const out = new Set<string>();
  for (const d of digests) {
    if (!d) continue;
    const list = d.allHeadlines ?? [...d.regions.tw.events, ...d.regions.world.events].map((e) => e.headline);
    for (const h of list) out.add(h);
  }
  return [...out].slice(0, MAX_HEADLINES);
}

// ── 排程 ─────────────────────────────────────────────

export interface InsightRunResult {
  stored: boolean;
  date: string | null;
  message: string;
}

/**
 * 產生收盤分析並存起來。今天沒有收盤資料（休市或抓取失敗）就不產生。
 * force（手動）：改成處理最新一天的資料，已經有分析也重做；模型這次失敗時保留原本的文字。
 */
export async function runInsightJob(env: Env, opts: { now?: number; force?: boolean; model?: TextModel } = {}): Promise<InsightRunResult> {
  const kv = env.NEWS;
  const date = opts.force ? (await getDays(kv))[0] : taipeiTime(opts.now ?? Date.now()).date;
  const snap = date ? await getClose(kv, date) : null;
  if (!date || !snap) return { stored: false, date: date ?? null, message: "沒有這一天的收盤資料，不產生分析" };

  const existing = await getInsight(kv, date);
  if (existing?.text && !opts.force) return { stored: false, date, message: "這一天已經有分析了" };

  const [streaks, headlines] = await Promise.all([loadStreaks(kv, snap), collectHeadlines(kv, date)]);
  const facts = buildFacts(snap, streaks);
  const model = opts.model ?? pickTextModel(env);
  const written = await writeInsight(facts, headlines, model);
  const text = written ?? existing?.text ?? null;
  const insight: MarketInsight = {
    ...facts,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    text,
    model: text ? (written ? model.model : (existing?.model ?? null)) : null,
  };
  await kv.put(insightKey(date), JSON.stringify(insight), { expirationTtl: CLOSE_TTL_SECONDS });
  return { stored: true, date, message: written ? `已存 ${date} 收盤分析` : `已存 ${date} 數字與排行，AI 評論沒有產生` };
}
