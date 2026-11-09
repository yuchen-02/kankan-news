/**
 * 台股收盤分析：每個交易日 14:50 產生一次。
 *
 * AI 只拿得到行情數字，看不到新聞，所以不會把某則新聞說成漲跌的原因。
 * 排行與新聞由程式直接產生；AI 的文字要通過 validateInsight 才會顯示，否則那天只顯示排行和新聞。
 */
import { pickTextModel, type TextModel } from "../summarizers/index.ts";
import type { Digest, DigestIndexEntry, EconNews, Env } from "../types.ts";
import { cmpCode, taipeiTime, type CloseQuote, type CloseSnapshot, type IndexQuote, type VolumeRank } from "./market.ts";
import { CLOSE_TTL_SECONDS, getClose, getDays } from "./store.ts";

const TOP_N = 5;
const MAX_NEWS = 5;
const MAX_TOKENS = 700;
const ATTEMPTS = 2;

/** 漲跌幅排行的一列：[代號, 名稱, 收盤價, 漲跌幅%] */
export type RankRow = [code: string, name: string, price: number | null, pct: number | null];

export interface MarketFacts {
  date: string;
  index: IndexQuote | null;
  breadth: { up: number; down: number; flat: number; none: number };
  gainers: RankRow[];
  losers: RankRow[];
  topVolume: VolumeRank[];
}

export interface MarketInsight extends MarketFacts {
  generatedAt: string;
  /** AI 寫的盤勢整理；模型失敗或沒通過檢查時是 null */
  text: string | null;
  model: string | null;
  news: EconNews[];
}

const insightKey = (date: string) => `stocks:insight:${date}`;
export const getInsight = (kv: KVNamespace, date: string) => kv.get<MarketInsight>(insightKey(date), "json");

const toRank = (q: CloseQuote): RankRow => [q[0], q[1], q[2], q[4]];

/** 收盤資料 → 給 AI 和頁面用的統計 */
export function buildFacts(snap: CloseSnapshot): MarketFacts {
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
    topVolume: snap.topVolume ?? [],
  };
}

// ── 給 AI 的內容 ─────────────────────────────────────

const FORBIDDEN = ["建議", "買進", "買入", "賣出", "加碼", "減碼", "預期", "預估", "預計", "後市", "看好", "看淡", "因為", "由於", "導致", "帶動", "拖累", "受惠", "受到", "影響", "反映", "利多", "利空"];

export const INSIGHT_SYSTEM = `你是台股盤後資料整理員，把我提供的當日行情數字寫成一段繁體中文（台灣慣用詞彙）的盤勢整理。

規則：
1. 寫 3 到 5 句，總長不超過 150 字，只輸出這段文字，不要標題、條列或其他說明。
2. 只能使用我提供的數字與股票名稱。數字照抄，不可四捨五入、換算或自己計算新的數字。
3. 內容依序是：加權指數的收盤與漲跌、上漲與下跌家數、漲跌幅和成交量較突出的股票。
4. 只描述今天的數字，不解釋原因、不連結任何事件、不預測後續、不給投資建議。
5. 語氣平實中性，不用情緒字眼。不可使用這些詞：${FORBIDDEN.join("、")}。`;

function rankLines(rows: RankRow[]): string {
  return rows.map((r) => `${r[0]} ${r[1]}：收盤 ${r[2] ?? "無"}，漲跌幅 ${r[3] ?? "無"}%`).join("\n") || "無";
}

export function buildInsightPrompt(f: MarketFacts): string {
  const i = f.index;
  const volume = f.topVolume.map((r) => `${r[0]} ${r[1]}：${r[2]} 張，漲跌幅 ${r[3] ?? "無"}%`).join("\n") || "無";
  return `日期：${f.date}
加權指數：收盤 ${i?.value ?? "無"}，漲跌 ${i?.change ?? "無"} 點，漲跌幅 ${i?.pct ?? "無"}%
家數：上漲 ${f.breadth.up}，下跌 ${f.breadth.down}，平盤 ${f.breadth.flat}，沒有成交 ${f.breadth.none}

漲幅前 ${f.gainers.length} 名：
${rankLines(f.gainers)}

跌幅前 ${f.losers.length} 名：
${rankLines(f.losers)}

成交量前 ${f.topVolume.length} 名：
${volume}`;
}

/** 輸入裡出現過的所有數字（取絕對值），文字裡的數字都要在這裡面 */
function allowedNumbers(f: MarketFacts): Set<number> {
  const prompt = buildInsightPrompt(f);
  const out = new Set<number>();
  for (const m of prompt.match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(m));
  // 「11 月 9 日」拆開寫也可以
  for (const part of f.date.split("-")) out.add(Number(part));
  return out;
}

export function cleanInsightText(raw: string): string {
  return raw.replace(/```[a-z]*/gi, "").replace(/\s*\n+\s*/g, "").trim();
}

/** 檢查模型寫的文字；沒問題回傳 null，否則回傳原因（重試時會告訴模型） */
export function validateInsight(text: string, f: MarketFacts): string | null {
  if (text.length < 30) return "內容太短";
  if (text.length > 300) return "內容太長，總長不可超過 150 字";
  const word = FORBIDDEN.find((w) => text.includes(w));
  if (word) return `不可使用「${word}」`;
  const allowed = allowedNumbers(f);
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(Number(m.replace(/,/g, "")))) return `數字 ${m} 不在提供的資料裡，數字要照抄`;
  }
  return null;
}

async function writeInsight(f: MarketFacts, model: TextModel): Promise<string | null> {
  const user = buildInsightPrompt(f);
  let note = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const text = cleanInsightText(await model.text(INSIGHT_SYSTEM, user + note, MAX_TOKENS));
      const problem = validateInsight(text, f);
      if (!problem) return text;
      console.error("insight rejected:", problem);
      note = `\n\n注意：上一次的輸出有問題：${problem}。請重寫。`;
    } catch (e) {
      console.error("insight model failed:", e instanceof Error ? e.message : e);
    }
  }
  return null;
}

// ── 新聞 ─────────────────────────────────────────────

/** 當天各期摘要的財經新聞（新的一期在前），依連結和標題去重。舊的摘要沒有 econNews，就從顯示中的新聞挑 */
export async function collectInsightNews(kv: KVNamespace, date: string, limit = MAX_NEWS): Promise<EconNews[]> {
  const index = (await kv.get<DigestIndexEntry[]>("index", "json")) ?? [];
  const entries = index.filter((e) => taipeiTime(Date.parse(e.generatedAt)).date === date);
  const digests = await Promise.all(entries.map((e) => kv.get<Digest>(`digest:${e.id}`, "json")));
  const urls = new Set<string>();
  const titles = new Set<string>();
  const out: EconNews[] = [];
  for (const d of digests) {
    if (!d) continue;
    const news: EconNews[] =
      d.econNews ??
      [...d.regions.tw.events, ...d.regions.world.events]
        .filter((e) => e.categories?.includes("經濟") && e.sources[0])
        .map((e) => ({ title: e.headline, url: e.sources[0].url, source: e.sources[0].name }));
    for (const n of news) {
      if (urls.has(n.url) || titles.has(n.title)) continue;
      urls.add(n.url);
      titles.add(n.title);
      out.push(n);
    }
  }
  return out.slice(0, limit);
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

  const facts = buildFacts(snap);
  const model = opts.model ?? pickTextModel(env);
  const [written, news] = await Promise.all([writeInsight(facts, model), collectInsightNews(kv, date)]);
  const text = written ?? existing?.text ?? null;
  const insight: MarketInsight = {
    ...facts,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    text,
    model: text ? (written ? model.model : (existing?.model ?? null)) : null,
    news,
  };
  await kv.put(insightKey(date), JSON.stringify(insight), { expirationTtl: CLOSE_TTL_SECONDS });
  return { stored: true, date, message: written ? `已存 ${date} 收盤分析` : `已存 ${date} 排行與新聞，AI 文字沒有產生` };
}
