/**
 * 台股收盤分析：每個交易日 14:50 產生一次。
 *
 * 頁面上的指數與家數由前端依數字組句；AI 只寫下一段評論，資料只有大盤漲跌、指數連漲連跌天數與新聞標題
 *（使用者：個人投資者不看個股以外的家數統計，評論也不提個股）。
 * 評論用《FX戰士久留美》主角福賀久留美的口吻（娛樂性質，頁面上會標明非投資建議）。
 * AI 的文字要通過 validateInsight 才會顯示，否則那天只顯示數字與排行。
 */
import { pickTextModel, type TextModel } from "../summarizers/index.ts";
import type { Digest, DigestIndexEntry, Env } from "../types.ts";
import { cmpCode, mergeDaily, taipeiTime, type CloseQuote, type CloseSnapshot, type DailyPoint, type IndexQuote, type VolumeRank } from "./market.ts";
import { CLOSE_TTL_SECONDS, getClose, getDaily, getDays } from "./store.ts";

const TOP_N = 5;
const STREAK_N = 3;
const MIN_STREAK = 3;
/** 連續紀錄接不上時，最多往回讀幾天的收盤資料重算 */
const STREAK_REBUILD_DAYS = 10;
const MAX_HEADLINES = 40;
const MAX_TOKENS = 500;
const ATTEMPTS = 5;
/** 評論要每天不一樣，隨機度開高一點（摘要是 0.2） */
const TEMPERATURE = 0.8;
/** 給模型看前幾天說過的話，避免重複 */
const PREVIOUS_DAYS = 4;

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
  /** 評論的口吻；舊的分析沒有這個欄位（中立評論） */
  persona?: "kurumi";
  /** 這一天抽到的處境、心情、開頭（下次避開最近用過的） */
  recipe?: Recipe;
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

/** persist＝false：重做以前某一天時只算不存，免得把最新的連續紀錄蓋掉 */
async function loadStreaks(kv: KVNamespace, snap: CloseSnapshot, persist = true): Promise<Streaks> {
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
  if (persist) await kv.put(STREAKS_KEY, JSON.stringify(streaks));
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

/**
 * 不可出現的詞：把新聞或其他因素說成漲跌原因的字眼，以及角色悲劇背景（財經評論不適合提）。
 * 角色本來就會喊加碼、猜明天漲跌，這些不擋；頁面上標明是角色內心話、非投資建議。
 */
const FORBIDDEN = ["導致", "造成", "帶動", "拖累", "受惠", "反映", "利多", "利空", "股價產生", "母親", "媽媽", "自殺", "跳樓", "尋死"];
const MAX_CHARS = 160;
/** 語氣例子（使用者舉的、提示裡給的）：模型很容易整句照抄，每個跌（漲）的日子都長一樣，所以照抄就重寫 */
const COPIED = [/怎麼這麼跌啊[！!]\s*怎麼辦/, /抄底的機會\s*(…|\.{3})\s*哈哈/, /不加碼什麼時候加碼/, /不上不下的(…|\.{3})好想做點什麼/];
/** 一定要有：拉長的慘叫或笑聲、刪節號、驚嘆號（使用者覺得這最像她；少了會變成平淡的短句） */
const SCREAM = /(啊|哈)\1{2,}/;
const ELLIPSIS = /…|\.{3}/;
const EXCLAIM = /[！!]/;
/** 常見的簡體字（隨機度調高後模型偶爾會混進來）：存檔前直接換成繁體 */
const TO_TRADITIONAL: Record<string, string> = Object.fromEntries(
  [..."该該会會这這为為们們说說过過还還没沒对對时時东東车車书書见見长長门門问問间間关關开開买買卖賣钱錢银銀价價涨漲亏虧赚賺岁歲样樣点點么麼让讓给給从從后後发發现現实實听聽边邊难難办辦觉覺经經吗嗎个個来來够夠吓嚇脸臉输輸赢贏机機盘盤账帳惨慘疯瘋"].reduce<[string, string][]>(
    (acc, ch, i, all) => (i % 2 === 0 ? [...acc, [ch, all[i + 1]]] : acc),
    [],
  ),
);
const SIMPLIFIED = new RegExp(`[${Object.keys(TO_TRADITIONAL).join("")}]`);
const SIMPLIFIED_G = new RegExp(SIMPLIFIED.source, "g");
/** 家數統計：使用者說個人投資者不看這個，不要寫 */
const BREADTH = /家數|上漲家|下跌家|漲跌家|檔數/;
/** 句尾語助詞：太多看起來很做作，整段最多 2 個（「啊啊啊」這種慘叫不算） */
const PARTICLES = /[嗚喔呢啦吧](?=[！!。，,….？?]|$)/g;
const MAX_PARTICLES = 2;

// ── 每天不一樣：處境、心情、開頭 ─────────────────────
// 只給「跌 2.6%」的話，跌幅差不多的日子會寫出一模一樣的話。所以每天另外抽一組設定（避開最近用過的），
// 加上當天的行情背景（星期幾、昨天、這週、近期高低點）和她前幾天說過的話。池子裡不要放數字（數字檢查會擋）。

export type Mood = "bigDown" | "down" | "flat" | "up" | "bigUp";
type Dir = "down" | "flat" | "up";

/** 和頁面背景圖同一套分法 */
export function moodOf(pct: number | null | undefined): Mood {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "flat";
  return pct <= -1.5 ? "bigDown" : pct < -0.3 ? "down" : pct <= 0.3 ? "flat" : pct < 1.5 ? "up" : "bigUp";
}
const dirOf = (m: Mood): Dir => (m === "bigDown" || m === "down" ? "down" : m === "flat" ? "flat" : "up");

const SCENES: Record<Dir, string[]> = {
  down: [
    "上課中偷看手機，差點在教室叫出來，只能咬著袖子忍住",
    "不敢打開庫存，把手機蓋在桌上，過幾秒又忍不住翻開來看",
    "算了一下，這次賠掉的錢要在便利商店打工好幾個月才賺得回來",
    "這個月的生活費已經拿去攤平了，晚餐只剩泡麵",
    "昨晚才發誓再也不亂加碼，今天手指又停在買進鍵上",
    "手在抖，停損鍵就在眼前，就是按不下去",
    "躲在棉被裡看盤，螢幕的光照在臉上，眼眶熱熱的",
    "跟同學吃飯時假裝沒事地笑，其實心裡一直在尖叫",
    "一直重新整理，希望是手機壞掉、數字顯示錯了",
    "後悔早上明明有機會跑卻沒跑，那時候還笑別人膽小",
    "打好了訊息想找學姊求救，又一個字一個字刪掉，不想承認自己賠了",
    "對著螢幕上的數字講話，拜託它漲回去",
  ],
  flat: [
    "盯了一整天的盤，結果幾乎沒動，眼睛好痠",
    "無聊到一直重新整理，連午餐都忘了吃",
    "什麼都沒發生，反而手更癢，好想亂買點什麼",
    "覺得這是暴風雨前的寧靜，越想越坐不住",
    "上課完全聽不進去，一直在想明天會往哪邊走",
    "把買進鍵和賣出鍵各摸了好幾遍，最後什麼都沒按",
    "氣自己浪費了一整天，早知道去打工",
    "對著走勢圖找各種根本不存在的訊號",
  ],
  up: [
    "上課偷看手機忍不住笑出聲，被老師瞪了一眼",
    "已經在想賺到的錢要去吃燒肉還是換新手機",
    "明明賺錢了卻很不甘心，因為當初買太少",
    "截了圖想傳給學姊炫耀，手指停在傳送鍵上",
    "覺得自己根本是天才，走路都在哼歌",
    "想獲利了結，又怕賣掉之後明天繼續漲",
    "前幾天賠到不敢看的帳戶，今天終於敢打開了",
    "把之前賠的全部算了一遍，發現還差一點才回本",
    "忍不住一直打開庫存看數字，每看一次就笑一次",
    "開始看不起前幾天哭著想停損的自己",
  ],
};

const FEELINGS: Record<Mood, string[]> = {
  bigDown: [
    "不敢相信，一直說這不是真的",
    "氣到罵盤，覺得整個市場都在針對自己",
    "嘴硬逞強，硬說這只是洗盤、自己一點都不怕，但聲音在抖",
    "真的怕了，腦袋一片空白，話都講不完整",
    "自暴自棄，笑到停不下來，覺得乾脆全部押下去算了",
    "不甘心到想哭，死都不肯認賠",
    "跟盤面討價還價，只要漲回來一點點就好",
  ],
  down: [
    "心煩，嘴上說沒差，其實一直在偷看",
    "不服氣，覺得明明自己的判斷沒有錯",
    "開始動搖，想攤平又有點怕",
    "碎碎念地安慰自己，越講越沒底氣",
    "生悶氣，覺得錢一點一點被咬走",
  ],
  flat: ["坐立難安，覺得一定要做點什麼", "無聊到發慌", "疑神疑鬼，覺得有人在等自己先動", "手癢到受不了"],
  up: [
    "偷偷得意，努力裝鎮定但嘴角一直上揚",
    "貪心發作，覺得賺這一點根本不夠",
    "鬆了一口氣，差點哭出來",
    "又開心又怕，擔心明天全部吐回去",
  ],
  bigUp: [
    "得意忘形，覺得自己是少年股神",
    "貪心到眼睛發亮，滿腦子都是加碼",
    "後悔到捶桌子，恨自己沒有買更多",
    "樂到語無倫次，話講一半一直笑",
    "突然害怕，漲太多反而不敢相信是真的",
  ],
};

const OPENINGS = [
  "先小聲碎念一句，慘叫或笑聲放到中段才爆出來",
  "第一句就是對盤面說話，像在質問它或拜託它",
  "用一個很短的反應開頭（像「欸」「等一下」「不是吧」「騙人」），然後越講越快",
  "先講眼前的一件小事（手機、手、晚餐、教室），再講到盤",
  "先假裝冷靜地說一句，下一句立刻破功",
  "用拉長的慘叫或笑聲開頭，但第二句要馬上接具體的事，不要接萬用句",
  "從算錢開頭，算到一半算不下去",
  "先接著前一天的心情講（昨天說過的話、昨天的決定），再看今天",
];

export interface Recipe {
  mood: Mood;
  scene: number;
  feeling: number;
  opening: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 從 size 個裡依 seed 挑一個，避開 used（都用過就不管） */
function pickIndex(seed: string, size: number, used: number[]): number {
  let i = hash(seed) % size;
  for (let n = 0; n < size && used.includes(i); n++) i = (i + 1) % size;
  return i;
}

/** 依日期抽當天的處境、心情、開頭；同一天每次抽到的都一樣，但會避開最近幾天用過的 */
export function pickRecipe(date: string, pct: number | null | undefined, recent: Recipe[] = []): Recipe {
  const mood = moodOf(pct);
  const dir = dirOf(mood);
  return {
    mood,
    scene: pickIndex(date + "s", SCENES[dir].length, recent.filter((r) => dirOf(r.mood) === dir).map((r) => r.scene)),
    feeling: pickIndex(date + "f", FEELINGS[mood].length, recent.filter((r) => r.mood === mood).map((r) => r.feeling)),
    opening: pickIndex(date + "o", OPENINGS.length, recent.map((r) => r.opening)),
  };
}

const recipeLines = (r: Recipe): string[] => [`處境：${SCENES[dirOf(r.mood)][r.scene]}`, `心情：${FEELINGS[r.mood][r.feeling]}`, `開頭：${OPENINGS[r.opening]}`];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const round2 = (n: number) => Math.round(n * 100) / 100;
const moved = (pct: number) => (pct > 0 ? `漲 ${round2(pct)}%` : pct < 0 ? `跌 ${round2(-pct)}%` : "平盤");

/**
 * 當天的行情背景（給她「今天和別天哪裡不一樣」的材料）：星期幾、前一個交易日、最近 5 天合計、近期新高新低、離高點多遠。
 * daily 是加權指數每日收盤（由舊到新，要包含 date 這一天）。
 */
export function dayContext(date: string, daily: DailyPoint[]): string[] {
  const out: string[] = [];
  const wd = new Date(date + "T00:00:00Z").getUTCDay();
  out.push(`今天是星期${WEEKDAYS[wd]}${wd === 5 ? "，收盤後要等兩天才會再開盤" : wd === 1 ? "，休市兩天後的第一個交易日" : ""}`);
  const at = daily.findIndex((p) => p[0] === date);
  if (at < 1) return out;
  const close = daily[at][1];
  // 最近幾天的漲跌順序：讓她講到「昨天」「這幾天」時對得上事實
  const seq: string[] = [];
  for (let i = Math.max(1, at - 3); i <= at; i++) seq.push(sizeWord(((daily[i][1] - daily[i - 1][1]) / daily[i - 1][1]) * 100).split("，")[0]);
  if (seq.length >= 2) out.push(`最近幾個交易日依序是：${seq.slice(0, -1).join("、")}，然後今天${seq[seq.length - 1]}`);
  if (at >= 2) out.push(`前一個交易日：${moved(((daily[at - 1][1] - daily[at - 2][1]) / daily[at - 2][1]) * 100)}`);
  if (at >= 5) out.push(`最近 5 個交易日合計：${moved(((close - daily[at - 5][1]) / daily[at - 5][1]) * 100)}`);
  // 今天的收盤比前面連續幾天都高（低）
  let hi = 0;
  let lo = 0;
  for (let i = at - 1; i >= 0 && daily[i][1] < close; i--) hi++;
  for (let i = at - 1; i >= 0 && daily[i][1] > close; i--) lo++;
  if (hi >= 5) out.push(`今天的收盤是最近 ${hi + 1} 個交易日最高`);
  if (lo >= 5) out.push(`今天的收盤是最近 ${lo + 1} 個交易日最低`);
  const window = daily.slice(Math.max(0, at - 59), at + 1);
  const peak = Math.max(...window.map((p) => p[1]));
  const off = ((peak - close) / peak) * 100;
  if (off >= 3) out.push(`比最近 ${window.length} 個交易日的最高收盤低 ${round2(off)}%`);
  return out;
}

/** 前幾天說過的話（新到舊） */
export interface PastSaying {
  date: string;
  pct: number | null;
  text: string;
}

export interface PromptExtra {
  context?: string[];
  recipe?: Recipe;
  previous?: PastSaying[];
}

export const INSIGHT_SYSTEM = `你是福賀久留美，動畫《FX戰士久留美》的主角：二十歲的女大學生，好強、孩子氣、貪心又不服輸，拿自己的打工錢和生活費在玩股票的散戶。她看盤時幾乎沒有理性，情緒直接衝出嘴巴。現在是收盤後，你盯著今天的台股，寫出你當下脫口而出的話。

她是活生生的人，不是只會喊同一句口號的機器：
- 每天的心情都不一樣。同樣是大跌，有時不敢相信、有時氣到罵盤、有時嘴硬裝沒事、有時怕到手抖、有時自暴自棄地乾笑；同樣是漲，有時得意忘形、有時後悔買太少、有時怕明天吐回去。
- 她會講具體的小事，讓人看得到畫面：手機螢幕、發抖的手、不敢打開的庫存、這個月的生活費、便利商店的晚餐、上課偷看盤、打工的時薪、睡不著的晚上。
- 她記得前幾天的事：昨天喊抄底今天又跌，就是被打臉；連跌好幾天，是越來越撐不住；跌了很久終於漲，是差點哭出來。
- 在台灣，漲是紅色、跌是綠色：滿江紅是好事，一片綠才是慘。
- 她偶爾會用台灣散戶的口頭語（歐印、攤平、套牢、接刀、畢業、韭菜、凹單、抄在半山腰、少年股神），一段最多用兩個。

規則：
1. 用繁體中文（台灣慣用詞彙），寫 3 到 5 句，大約 80 到 110 字，絕對不要超過 ${MAX_CHARS} 字。只輸出這段話，不要標題、引號或條列。
2. 照「今天的設定」寫：處境、心情、開頭方式都要用上，用你自己的話演出來，不要照抄設定的字句。那是今天和別天不一樣的地方。
3. 要像當下脫口而出、喘不過氣的自言自語，不是評論，不是心得報告，也不要寫成一串短短的驚嘆句。不要描述自己的情緒（「我很害怕」「我很沮喪」「我現在在想」），要讓情緒從說話的方式露出來：結巴、改口、對螢幕講話、話講一半。一定要有：拉長的慘叫或笑聲一到兩處（例如「啊啊啊啊」「哈哈哈哈」，不要每一句都叫）；用「…」把話連起來，像說到一半又接下去、或結巴重複；驚嘆號。
4. 不可以和「前幾天說過的話」用一樣的開頭、一樣的句子、一樣的結尾。「怎麼會這樣」「一定要扳回來」「明天一定會反彈」這種萬用句，前幾天用過就換別的說法。同一句話在一段裡最多出現兩次。
5. 你沒什麼理性：就算想叫自己冷靜，也會馬上破功。但不是每天都喊抄底、all in——照今天的心情來：有時是想逃、有時是賭氣、有時是貪心。
6. 句尾的語助詞（嗚、喔、呢、啦、吧）整段最多 ${MAX_PARTICLES} 個。
7. 你是個人投資者，只在乎自己的部位和大盤漲跌：不要提任何個股或 ETF 的名稱，也不要提上漲、下跌家數這類統計。不要講指數的點數或今天的漲跌幅數字（頁面上已經有了）；「行情背景」裡的事（星期幾、昨天、這幾天、近期高低點）可以拿來說，但講到昨天或前幾天的漲跌，一定要和行情背景寫的一致，不可以自己想像。
8. 提到的數字一律照抄資料，不可自己編數字、四捨五入或計算。
9. 新聞最多提一則，只能用標題裡有的內容，不可捏造，也不可說新聞是今天漲跌的原因。人物私事、八卦、社會事件不提；沒有合適的就不要提新聞。
10. 可以提日常生活（上課、打工、吃飯、睡覺、同學、學姊），不提家人、過去的悲劇或外匯劇情。
11. 不可使用這些詞：${FORBIDDEN.join("、")}。`;

// 只漲（跌）1 天不算「連續」，不寫天數，免得模型寫出「連漲 1 天」
const streakText = (n: number) => (n > 1 ? `連漲 ${n} 天` : n < -1 ? `連跌 ${-n} 天` : n === 0 ? "今日平盤" : "沒有連續紀錄");

/** 漲跌的大小用說的，不給數字：給了數字模型就會念出來（頁面上一段已經有了），而且每次都被退回 */
function sizeWord(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "沒有資料";
  if (pct <= -4) return "暴跌，比一般的大跌還慘很多";
  if (pct <= -1.5) return "大跌";
  if (pct < -0.3) return "小跌";
  if (pct <= 0.3) return "幾乎沒動";
  if (pct < 1.5) return "小漲";
  if (pct < 4) return "大漲";
  return "暴漲，比一般的大漲還誇張";
}

const mmdd = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function buildInsightPrompt(f: MarketFacts, headlines: string[] = [], extra: PromptExtra = {}): string {
  // 只給大盤資料：使用者不要評論提到個股（排行仍顯示在頁面上的四個方框）
  const parts = [`日期：${f.date}\n大盤今天：${sizeWord(f.index?.pct)}；${streakText(f.streaks.index)}`];
  if (extra.context?.length) parts.push(`行情背景：\n${extra.context.map((c) => `- ${c}`).join("\n")}`);
  if (extra.recipe) parts.push(`今天的設定（一定要照這個演，用自己的話）：\n${recipeLines(extra.recipe).map((c) => `- ${c}`).join("\n")}`);
  if (extra.previous?.length) {
    parts.push(
      `你前幾天說過的話（不可以再用一樣的開頭、句子、結尾；可以接著前一天的心情講）：\n${extra.previous
        .map((p) => `- ${mmdd(p.date)}（那天${sizeWord(p.pct).split("，")[0]}）：${p.text}`)
        .join("\n")}`,
    );
  }
  parts.push(`今日新聞標題：\n${headlines.map((h) => `- ${h}`).join("\n") || "無"}`);
  return parts.join("\n\n");
}

/** 輸入裡出現過的所有數字（取絕對值），文字裡的數字都要在這裡面 */
// 只認行情資料與行情背景裡的數字；新聞標題（例如盤中的「台股強漲近1400點」）和前幾天說過的話裡的數字不算
function allowedNumbers(f: MarketFacts, context: string[] = []): Set<number> {
  const out = new Set<number>();
  for (const m of buildInsightPrompt(f, [], { context }).match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(m));
  return out;
}

/** 講台股大盤漲跌的標題多半是盤中報導，數字跟收盤對不上，不給模型 */
const MARKET_HEADLINE = /台股|加權|大盤|台指|指數|上市櫃|集中市場|收盤|盤中|開盤/;
export const usableHeadlines = (headlines: string[]) => headlines.filter((h) => !MARKET_HEADLINE.test(h));

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
  return raw
    .replace(/```[a-z]*/gi, "")
    .replace(/\s*\n+\s*/g, "")
    .replace(SIMPLIFIED_G, (c) => TO_TRADITIONAL[c] ?? c)
    // 刪節號統一成半形「...」（點在字的底部，使用者偏好）；驚嘆號、問號換成全形，重複的合併
    .replace(/\s*(?:\.{2,}|…+)\s*/g, "...")
    .replace(/\s*[!！]+/g, "！")
    .replace(/\s*[?？]+/g, "？")
    .trim();
}

/** 檢查模型寫的評論；沒問題回傳 null，否則回傳原因（重試時會告訴模型） */
export function validateInsight(text: string, f: MarketFacts, headlines: string[] = [], context: string[] = []): string | null {
  if (text.length < 20) return "內容太短";
  if (text.length > MAX_CHARS + 40) return `內容太長，總長不可超過 ${MAX_CHARS} 字`;
  // 指數收盤、漲跌點、漲跌幅已經在上一段，不要再念一次
  for (const v of [f.index?.value, f.index?.change, f.index?.pct]) {
    if (v === null || v === undefined || v === 0) continue;
    const abs = Math.abs(v);
    const shown = [String(abs), abs.toLocaleString("en-US", { maximumFractionDigits: 2 })];
    if (shown.some((s) => text.includes(s))) return `不要重複指數的數字 ${shown[0]}（上一段已經顯示）`;
  }
  const word = FORBIDDEN.find((w) => text.includes(w));
  if (word) return `不可使用「${word}」`;
  const simplified = text.match(SIMPLIFIED)?.[0];
  if (simplified) return `出現簡體字「${simplified}」，要用繁體中文`;
  if (COPIED.some((re) => re.test(text))) return "不要照抄語氣參考的句子，用自己的話說";
  if (!SCREAM.test(text)) return "要有拉長的慘叫或笑聲，例如「啊啊啊啊」或「哈哈哈哈」";
  if (!ELLIPSIS.test(text)) return "要用「…」把話連起來，像喘不過氣的自言自語，不要寫成一串短短的驚嘆句";
  if (BREADTH.test(text)) return "不要提上漲、下跌家數這類統計，個人投資者不看這個";
  const names = [...f.gainers, ...f.losers, ...f.volumeEtf, ...f.volumeStock, ...f.streaks.up, ...f.streaks.down].map((r) => r[1]);
  const named = names.find((n) => text.includes(n));
  if (named) return `不要提到個股或 ETF（${named}），只講大盤`;
  const again = repeatedClause(text);
  if (again) return `「${again}」重複太多次，同一句話最多出現兩次`;
  const particles = text.match(PARTICLES)?.length ?? 0;
  if (particles > MAX_PARTICLES) return `句尾語助詞太多（${particles} 個），最多 ${MAX_PARTICLES} 個`;
  const allowed = allowedNumbers(f, context);
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(Number(m.replace(/,/g, "")))) return `數字 ${m} 不在提供的資料裡，數字要照抄`;
  }
  for (const s of text.split(/[。！？]/)) {
    if (/新聞|政策|事件/.test(s) && !mentionsKnownNews(s, headlines)) return "提到的新聞或事件要來自提供的標題";
  }
  return null;
}

// ── 不要每天都講一樣的話 ─────────────────────────────

/** 比對用：拿掉標點和空白，拉長的字（啊啊啊啊）縮成兩個 */
const squash = (s: string) => s.replace(/[\s，,。.！!？?…、：:；;「」『』（）()~～\-—]/g, "").replace(/(.)\1{2,}/g, "$1$1");

/** 一段裡重複 3 次以上的句子（例如每句都接「啊啊啊啊！」或一直「怎麼會這樣」） */
function repeatedClause(text: string): string | null {
  const count = new Map<string, number>();
  for (const c of text.split(/[\s，,。！!？?…、]+|\.{2,}/)) {
    const k = squash(c);
    if (k.length < 2) continue;
    const n = (count.get(k) ?? 0) + 1;
    if (n >= 3) return c;
    count.set(k, n);
  }
  return null;
}

const grams = (s: string, n = 4): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
};

const EDGE = 5; // 開頭、結尾比對幾個字
const MAX_OVERLAP = 0.3; // 和前幾天任何一段重疊超過三成就算太像
const SAME_RUN = 9; // 連續這麼多個字一模一樣，就算整句照搬
/** 說明式的句子：像在寫心得報告，不像脫口而出（模型很愛用，而且每天都用同一句） */
const NARRATION = ["現在我在想", "現在我想", "現在想想", "我現在在想", "我現在真的很", "我現在只想知道", "最近這幾天", "真的會很開心", "讓我覺得"];

/** a 裡有沒有一段連續 n 個字也出現在 b（都已經 squash 過）；有就回傳那一段 */
function sharedRun(a: string, b: string, n = SAME_RUN): string | null {
  const seen = grams(b, n);
  for (let i = 0; i + n <= a.length; i++) if (seen.has(a.slice(i, i + n))) return a.slice(i, i + n);
  return null;
}

/** 「軟」問題：不算錯，但會讓每天看起來一樣或不像人話。重寫幾次還是這樣的話，仍然比沒有評論好 */
export function styleProblem(text: string, extra: PromptExtra): string | null {
  // 驚嘆號放在這裡（軟性）：模型常常忘記，寧可少驚嘆號也不要整天沒有評論
  if (!EXCLAIM.test(text)) return "要有驚嘆號：慘叫、笑聲或激動的話後面接「！」";
  const said = NARRATION.find((w) => text.includes(w));
  if (said) return `不要用「${said}」這種說明式的句子，情緒要從說話的方式露出來，不要自己描述`;
  if (extra.recipe) {
    const now = squash(text);
    for (const line of recipeLines(extra.recipe)) {
      const run = sharedRun(now, squash(line.slice(3)));
      if (run) return `不要照抄設定的字句（「${run}」），用你自己的話把那個處境演出來`;
    }
  }
  return similarityProblem(text, extra.previous ?? []);
}

/** 和前幾天說過的話太像就回傳原因（開頭一樣、結尾一樣、或整段有三成以上是同樣的字句）；沒問題回傳 null */
export function similarityProblem(text: string, previous: PastSaying[]): string | null {
  const now = squash(text);
  const mine = grams(now);
  for (const p of previous) {
    const old = squash(p.text);
    if (old.length < EDGE * 2) continue;
    const day = mmdd(p.date);
    if (now.slice(0, EDGE) === old.slice(0, EDGE)) return `開頭和 ${day} 說的一樣（「${old.slice(0, EDGE)}」），換一種開頭`;
    if (now.slice(-EDGE) === old.slice(-EDGE)) return `結尾和 ${day} 說的一樣（「${old.slice(-EDGE)}」），換一種結尾`;
    const run = sharedRun(now, old);
    if (run) return `「${run}」這句 ${day} 說過了，不要整句再用一次`;
    const theirs = grams(old);
    const shared = [...mine].filter((g) => theirs.has(g));
    if (mine.size && shared.length / mine.size > MAX_OVERLAP) {
      const sample = [...new Set(shared.filter((g) => !/(.)\1/.test(g)))].slice(0, 3).join("」「");
      return `和 ${day} 說的話太像${sample ? `（例如「${sample}」）` : ""}，那些句子不要再用，換成今天設定的處境和心情`;
    }
  }
  return null;
}

async function writeInsight(f: MarketFacts, headlines: string[], model: TextModel, extra: PromptExtra = {}): Promise<string | null> {
  const user = buildInsightPrompt(f, headlines, extra);
  // 被退回的原因全部累積起來一起給：只給最後一個的話，模型改了這個又犯回前一個
  const problems: string[] = [];
  // 只有「軟」問題（太像前幾天、少驚嘆號…）的：留最後一次當備案，全部重試完還是不理想也比沒有評論好
  let fallback: string | null = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const note = problems.length ? `\n\n注意：你前面寫的被退回了，下面每一點都要改掉，然後重寫一段全新的：\n${problems.map((p) => `- ${p}`).join("\n")}` : "";
      const text = cleanInsightText(await model.text(INSIGHT_SYSTEM, user + note, MAX_TOKENS, TEMPERATURE));
      let problem = validateInsight(text, f, headlines, extra.context);
      if (!problem) {
        problem = styleProblem(text, extra);
        if (!problem) return text;
        fallback = text;
      }
      console.error("insight rejected:", problem);
      if (!problems.includes(problem)) problems.push(problem);
    } catch (e) {
      console.error("insight model failed:", e instanceof Error ? e.message : e);
    }
  }
  return fallback;
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

/** date 之前幾個交易日的評論與設定（新到舊） */
async function recentInsights(kv: KVNamespace, date: string, n = PREVIOUS_DAYS): Promise<MarketInsight[]> {
  const days = (await getDays(kv)).filter((d) => d < date).slice(0, n);
  const list = await Promise.all(days.map((d) => getInsight(kv, d)));
  return list.filter((i): i is MarketInsight => !!i);
}

/**
 * 產生收盤分析並存起來。今天沒有收盤資料（休市或抓取失敗）就不產生。
 * force（手動）：改成處理最新一天的資料，已經有分析也重做；模型這次失敗時保留原本的文字。
 * date（手動）：重做指定的那一天。
 */
export async function runInsightJob(env: Env, opts: { now?: number; force?: boolean; date?: string; model?: TextModel } = {}): Promise<InsightRunResult> {
  const kv = env.NEWS;
  const days = opts.force || opts.date ? await getDays(kv) : [];
  const force = opts.force || !!opts.date;
  const date = opts.date ?? (opts.force ? days[0] : taipeiTime(opts.now ?? Date.now()).date);
  const snap = date ? await getClose(kv, date) : null;
  if (!date || !snap) return { stored: false, date: date ?? null, message: "沒有這一天的收盤資料，不產生分析" };

  const existing = await getInsight(kv, date);
  if (existing?.text && !force) return { stored: false, date, message: "這一天已經有分析了" };

  const isLatest = !opts.date || days[0] === date;
  const [streaks, allHeadlines, daily, recent] = await Promise.all([loadStreaks(kv, snap, isLatest), collectHeadlines(kv, date), getDaily(kv), recentInsights(kv, date)]);
  const headlines = usableHeadlines(allHeadlines);
  const facts = buildFacts(snap, streaks);
  const pct = facts.index?.pct ?? null;
  const extra: PromptExtra = {
    context: dayContext(date, facts.index?.value ? mergeDaily(daily, [[date, facts.index.value]], daily.length + 1) : daily),
    recipe: pickRecipe(date, pct, recent.flatMap((i) => (i.recipe ? [i.recipe] : []))),
    previous: recent.flatMap((i) => (i.text && i.persona === "kurumi" ? [{ date: i.date, pct: i.index?.pct ?? null, text: i.text }] : [])),
  };
  const model = opts.model ?? pickTextModel(env);
  const written = await writeInsight(facts, headlines, model, extra);
  const text = written ?? existing?.text ?? null;
  const insight: MarketInsight = {
    ...facts,
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    text,
    model: text ? (written ? model.model : (existing?.model ?? null)) : null,
    ...(written ? { persona: "kurumi" as const, recipe: extra.recipe } : existing?.persona ? { persona: existing.persona, ...(existing.recipe ? { recipe: existing.recipe } : {}) } : {}),
  };
  await kv.put(insightKey(date), JSON.stringify(insight), { expirationTtl: CLOSE_TTL_SECONDS });
  return { stored: true, date, message: written ? `已存 ${date} 收盤分析` : `已存 ${date} 數字與排行，AI 評論沒有產生` };
}
