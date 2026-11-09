import type { VisitCounter } from "./counter.ts";
import type { StockHub } from "./stocks/hub.ts";

export type Region = "tw" | "world";

export interface Env {
  AI: Ai;
  NEWS: KVNamespace;
  /** 訪客計數（Durable Object）。沒綁定時計數功能自動關閉，其他功能不受影響 */
  COUNTER?: DurableObjectNamespace<VisitCounter>;
  /** 台股盤中推送（Durable Object）。沒綁定時台股頁面只顯示收盤價 */
  STOCKS?: DurableObjectNamespace<StockHub>;
  /** 每個 IP 的 API 流量限制。沒綁定時不限制 */
  API_LIMIT?: RateLimit;
  /** "workers-ai"（預設）或 "claude" */
  SUMMARIZER?: string;
  AI_MODEL?: string;
  CLAUDE_MODEL?: string;
  MAX_EVENTS_TW?: string;
  MAX_EVENTS_WORLD?: string;
  /** 每個區塊向 AI 要幾則（預設 11），影響 Workers AI 額度用量 */
  MAX_EVENTS_ASK?: string;
  /** secret：只有用 Claude 摘要時才需要 */
  ANTHROPIC_API_KEY?: string;
  /** secret：設定後才會開放 POST /api/refresh（手動觸發） */
  REFRESH_TOKEN?: string;
}

/** 從 RSS 解析出來、尚未編號的文章 */
export interface RawItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt: number | null;
  /** RSS 本身帶的圖片網址（沒有就是 undefined） */
  imageUrl?: string;
}

/** 送給摘要函式的文章，id 從 1 開始，摘要函式只能引用這些編號 */
export interface Article {
  id: number;
  source: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: number;
  imageUrl?: string;
}

export interface SummarizeInput {
  region: Region;
  articles: Article[];
  windowStart: number;
  windowEnd: number;
  maxEvents: number;
}

/** 模型回傳的單一事件（尚未對應到來源連結） */
export interface RawEvent {
  headline: string;
  summary: string;
  disputed: string | null;
  articleIds: number[];
  /** 新聞類型標籤（見 categories.ts）；模型沒給或給了無效值時是 undefined */
  categories?: string[];
  /** 只有「台灣」那一輪會問：true＝事件發生在國外、台灣只是附帶（流程會把它移到「世界」頁）。其他情況是 undefined */
  foreign?: boolean;
}

/** 可替換的摘要函式：輸入文章，輸出事件。要換模型只要實作這個型別。 */
export type Summarizer = (input: SummarizeInput) => Promise<RawEvent[]>;

export interface SourceLink {
  name: string;
  url: string;
  title: string;
}

export interface DigestEvent {
  headline: string;
  summary: string;
  disputed: string | null;
  sources: SourceLink[];
  sourceCount: number;
  /** 新聞類型標籤；舊的摘要沒有這個欄位 */
  categories?: string[];
  /** 縮圖網址（直接引用媒體的圖）；找不到就沒有這個欄位 */
  imageUrl?: string;
  /** 該事件引用的不同文章各自的圖（最多 2 張、不重複）；頭條卡片有兩張時並排顯示。只有一張時沒有這個欄位 */
  imageUrls?: string[];
}

export interface SourceStatus {
  name: string;
  ok: boolean;
  /** 落在這次時間範圍內的文章數 */
  count: number;
  /** feed 裡總共有幾篇（不論時間） */
  fetched?: number;
  /** feed 裡最新一篇的發布時間 */
  newestAt?: string;
  error?: string;
}

export interface RegionDigest {
  events: DigestEvent[];
  sources: SourceStatus[];
  articleCount: number;
  error?: string;
}

export interface Digest {
  id: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  summarizer: string;
  model: string;
  regions: Record<Region, RegionDigest>;
  /** 裁成網站顯示的則數之前，兩區所有新聞的標題（收盤分析用，不會給訪客）；舊的摘要沒有這個欄位 */
  allHeadlines?: string[];
}

export interface DigestIndexEntry {
  id: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  counts: Record<Region, number>;
}
