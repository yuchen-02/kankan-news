import { FEEDS, PER_SOURCE_CAP, type Feed } from "./feeds.ts";
import { fetchOgImage } from "./images.ts";
import { parseFeed } from "./rss.ts";
import { pickSummarizer, type ChosenSummarizer } from "./summarizers/index.ts";
import type {
  Article,
  Digest,
  DigestEvent,
  DigestIndexEntry,
  Env,
  RawItem,
  Region,
  RegionDigest,
  SourceLink,
  SourceStatus,
} from "./types.ts";

const HOUR = 3600_000;
const DEFAULT_WINDOW_HOURS = 8;
const MAX_WINDOW_HOURS = 24;
const OVERLAP_MS = 10 * 60_000;
const KEEP_INDEX = 60;
const DIGEST_TTL_SECONDS = 60 * 60 * 24 * 21;

export interface Deps {
  fetch?: typeof fetch;
  now?: Date;
  summarizer?: ChosenSummarizer;
  feeds?: Feed[];
  /**
   * false = 只預覽：算出結果但不寫入 KV，不影響 latest／index，也就不影響之後排程的時間範圍。
   * 例外：KV 裡還沒有任何摘要時（第一次部署）一定會儲存，否則頁面會是空的。
   * 預設 true（排程用）。
   */
  persist?: boolean;
}

export interface RunResult {
  digest: Digest;
  /** 這份摘要是否真的寫進了 KV */
  stored: boolean;
}

// ── 工具 ─────────────────────────────────────────────

function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.search = "";
    return (url.host + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function digestId(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
}

// ── 抓取與整理 ───────────────────────────────────────

async function fetchFeed(feed: Feed, f: typeof fetch): Promise<RawItem[]> {
  const res = await f(feed.url, {
    headers: {
      "user-agent": "news-digest/1.0 (personal RSS digest)",
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = parseFeed(await res.text());
  if (items.length === 0) throw new Error("沒有解析出任何文章（feed 格式可能改了）");
  return items;
}

interface Collected {
  articles: Article[];
  sources: SourceStatus[];
}

async function collectRegion(region: Region, since: number, until: number, deps: Required<Pick<Deps, "fetch" | "feeds">>): Promise<Collected> {
  const feeds = deps.feeds.filter((f) => f.region === region);

  const results = await Promise.all(
    feeds.map(async (feed) => {
      try {
        const items = await fetchFeed(feed, deps.fetch);
        const recent = items.filter((i) => i.publishedAt !== null && i.publishedAt >= since && i.publishedAt <= until + HOUR);
        const newest = items.reduce((m, i) => Math.max(m, i.publishedAt ?? 0), 0);
        const status: SourceStatus = { name: feed.name, ok: true, count: recent.length, fetched: items.length };
        if (newest > 0) status.newestAt = new Date(newest).toISOString();
        return { feed, recent, status };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { feed, recent: [] as RawItem[], status: { name: feed.name, ok: false, count: 0, error: msg.slice(0, 120) } as SourceStatus };
      }
    }),
  );

  // 先依時間新到舊排序，再每家媒體取前 N 篇，同時用網址與標題去重
  const pool: { source: string; item: RawItem }[] = [];
  for (const r of results) for (const item of r.recent) pool.push({ source: r.feed.name, item });
  pool.sort((a, b) => (b.item.publishedAt ?? 0) - (a.item.publishedAt ?? 0));

  const perSource = new Map<string, number>();
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  const articles: Article[] = [];
  for (const { source, item } of pool) {
    const used = perSource.get(source) ?? 0;
    if (used >= PER_SOURCE_CAP[region]) continue;
    const u = canonicalUrl(item.url);
    const t = normalizeTitle(item.title);
    if (seenUrl.has(u) || seenTitle.has(`${source}:${t}`)) continue;
    seenUrl.add(u);
    seenTitle.add(`${source}:${t}`);
    perSource.set(source, used + 1);
    articles.push({
      id: articles.length + 1,
      source,
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      publishedAt: item.publishedAt as number,
      ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    });
  }

  return { articles, sources: results.map((r) => r.status) };
}

// ── 摘要結果 → 帶來源連結的事件 ─────────────────────

interface EventWithArticles {
  event: DigestEvent;
  /** 這個事件引用的文章（依模型給的順序，已去掉不存在的編號） */
  articles: Article[];
}

function toEvents(raw: Awaited<ReturnType<ChosenSummarizer["run"]>>, articles: Article[]): EventWithArticles[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const events: EventWithArticles[] = [];
  for (const e of raw) {
    const seen = new Set<string>();
    const sources: SourceLink[] = [];
    const used: Article[] = [];
    for (const id of e.articleIds) {
      const a = byId.get(id);
      if (!a) continue;
      used.push(a);
      if (seen.has(a.source)) continue;
      seen.add(a.source);
      sources.push({ name: a.source, url: a.url, title: a.title });
    }
    // 連結一律來自原始文章，模型沒辦法自己編網址
    if (sources.length === 0) continue;
    events.push({
      event: {
        headline: e.headline,
        summary: e.summary,
        disputed: e.disputed,
        sources,
        sourceCount: sources.length,
        ...(e.categories?.length ? { categories: e.categories } : {}),
      },
      articles: used,
    });
  }
  return events;
}

/** 整個流程最多去讀幾個文章網頁找 og:image（免費方案每次執行最多 50 個對外請求，要留給 RSS 與 AI） */
const OG_FETCH_BUDGET = 24;
const OG_TRIES_PER_EVENT = 2;

/**
 * 每個事件的縮圖：先用引用文章裡「第一篇有圖的」RSS 圖片；
 * 都沒有的話，依序去讀該事件前幾篇文章的網頁找 og:image（受總量上限限制）。找不到就不放圖。
 */
async function attachImages(items: EventWithArticles[], f: typeof fetch, budget: { left: number }): Promise<void> {
  await Promise.all(
    items.map(async ({ event, articles }) => {
      const fromFeed = articles.find((a) => a.imageUrl)?.imageUrl;
      if (fromFeed) {
        event.imageUrl = fromFeed;
        return;
      }
      for (const a of articles.slice(0, OG_TRIES_PER_EVENT)) {
        if (budget.left <= 0) return;
        budget.left--;
        const img = await fetchOgImage(a.url, f);
        if (img) {
          event.imageUrl = img;
          return;
        }
      }
    }),
  );
}

async function buildRegion(
  region: Region,
  since: number,
  until: number,
  env: Env,
  deps: Required<Pick<Deps, "fetch" | "feeds">>,
  summarizer: ChosenSummarizer,
  ogBudget: { left: number },
): Promise<RegionDigest> {
  const { articles, sources } = await collectRegion(region, since, until, deps);
  const base: RegionDigest = { events: [], sources, articleCount: articles.length };
  if (articles.length === 0) return base;

  const maxEvents = Number((region === "tw" ? env.MAX_EVENTS_TW : env.MAX_EVENTS_WORLD) ?? 8) || 8;
  try {
    const raw = await summarizer.run({ region, articles, windowStart: since, windowEnd: until, maxEvents });
    const chosen = toEvents(raw, articles).slice(0, maxEvents);
    await attachImages(chosen, deps.fetch, ogBudget);
    base.events = chosen.map((c) => c.event);
  } catch (e) {
    base.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  return base;
}

// ── 主流程 ───────────────────────────────────────────

export async function runPipeline(env: Env, deps: Deps = {}): Promise<RunResult> {
  const f = deps.fetch ?? fetch;
  const feeds = deps.feeds ?? FEEDS;
  const now = deps.now ?? new Date();
  const summarizer = deps.summarizer ?? pickSummarizer(env);

  // 時間範圍：從上一份摘要的產生時間開始（略微重疊避免漏掉），最長回溯 24 小時
  const previous = await env.NEWS.get<Digest>("latest", "json");
  const until = now.getTime();
  const since = previous
    ? Math.max(Date.parse(previous.generatedAt) - OVERLAP_MS, until - MAX_WINDOW_HOURS * HOUR)
    : until - DEFAULT_WINDOW_HOURS * HOUR;

  const ogBudget = { left: OG_FETCH_BUDGET };
  const [tw, world] = await Promise.all([
    buildRegion("tw", since, until, env, { fetch: f, feeds }, summarizer, ogBudget),
    buildRegion("world", since, until, env, { fetch: f, feeds }, summarizer, ogBudget),
  ]);

  // 兩個區塊都失敗就不要覆蓋掉上一份還能用的摘要
  if (tw.error && world.error) {
    throw new Error(`兩個區塊都摘要失敗。台灣：${tw.error}；世界：${world.error}`);
  }

  const digest: Digest = {
    id: digestId(now),
    generatedAt: now.toISOString(),
    windowStart: new Date(since).toISOString(),
    windowEnd: now.toISOString(),
    summarizer: summarizer.name,
    model: summarizer.model,
    regions: { tw, world },
  };

  // 預覽模式：已經有摘要時不寫入任何東西
  if (deps.persist === false && previous) return { digest, stored: false };

  await env.NEWS.put(`digest:${digest.id}`, JSON.stringify(digest), { expirationTtl: DIGEST_TTL_SECONDS });
  await env.NEWS.put("latest", JSON.stringify(digest));

  const index = (await env.NEWS.get<DigestIndexEntry[]>("index", "json")) ?? [];
  const entry: DigestIndexEntry = {
    id: digest.id,
    generatedAt: digest.generatedAt,
    windowStart: digest.windowStart,
    windowEnd: digest.windowEnd,
    counts: { tw: tw.events.length, world: world.events.length },
  };
  await env.NEWS.put("index", JSON.stringify([entry, ...index.filter((e) => e.id !== entry.id)].slice(0, KEEP_INDEX)));

  return { digest, stored: true };
}
