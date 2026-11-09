/**
 * 台股：抓資料（證交所）與存取 KV。
 *
 * KV 的 key（全部放在 NEWS 這個 namespace，前綴 stocks:）：
 * - stocks:universe          上市股票清單 [代號, 名稱][]，每次抓收盤價時更新
 * - stocks:close:YYYY-MM-DD  那一天的收盤資料（保留約 4 個月後自動過期）
 * - stocks:days              有收盤資料的日期清單（新到舊）
 * - stocks:status            今天收盤價的抓取狀態
 * 一天大約寫 4–5 次，遠低於免費方案每天 1,000 次。
 */
import {
  buildLive,
  changeOf,
  misBatches,
  misUrl,
  parseIndexClose,
  parseMis,
  parseStockList,
  taipeiTime,
  topVolumeOf,
  type CloseQuote,
  type CloseSnapshot,
  type CloseStatus,
  type LiveSnapshot,
  type MisRow,
  type StockName,
} from "./market.ts";

type Fetch = typeof fetch;

export const KEEP_DAYS = 122; // 約 4 個月
export const CLOSE_TTL_SECONDS = 60 * 60 * 24 * (KEEP_DAYS + 1);
const K = {
  universe: "stocks:universe",
  days: "stocks:days",
  status: "stocks:status",
  close: (date: string) => `stocks:close:${date}`,
};

const UA = { "user-agent": "Mozilla/5.0 (compatible; news-digest)" };
const STOCK_LIST_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const INDEX_CLOSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";

// ── 證交所 ──────────────────────────────────────────

export async function fetchStockList(f: Fetch = fetch): Promise<StockName[]> {
  const res = await f(STOCK_LIST_URL, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`股票清單 HTTP ${res.status}`);
  const list = parseStockList(await res.json());
  if (list.length < 500) throw new Error(`股票清單太短（${list.length} 檔）`);
  return list;
}

const MIS_RETRY_DELAY_MS = 500;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 抓一批 MIS；短暫的伺服器錯誤（5xx、連線中斷）隔一下再試一次。逾時已經等了 8 秒，不重試 */
async function fetchMisBatch(chs: string[], f: Fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await f(misUrl(chs), { headers: UA, signal: AbortSignal.timeout(8_000) });
      if (res.status < 500 || attempt > 0) return res;
    } catch (e) {
      if (attempt > 0 || (e instanceof Error && e.name === "TimeoutError")) throw e;
    }
    await wait(MIS_RETRY_DELAY_MS);
  }
}

/** 抓 MIS（全部批次同時送出）。任何一批重試後仍失敗就整個失敗，避免畫面上一半新一半舊 */
export async function fetchMis(codes: string[], f: Fetch = fetch): Promise<MisRow[]> {
  const batches = misBatches(codes);
  const results = await Promise.all(
    batches.map(async (chs) => {
      const res = await fetchMisBatch(chs, f);
      if (!res.ok) throw new Error(`MIS HTTP ${res.status}`);
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("MIS 回傳的不是 JSON（可能被暫時擋下）");
      }
      const rtcode = (json as { rtcode?: string }).rtcode;
      if (rtcode && rtcode !== "0000") throw new Error(`MIS 回傳錯誤：${(json as { rtmessage?: string }).rtmessage ?? rtcode}`);
      return parseMis(json);
    }),
  );
  return results.flat();
}

export async function fetchLive(codes: string[], prevPrices?: Map<string, number | null>, f: Fetch = fetch): Promise<LiveSnapshot> {
  return buildLive(await fetchMis(codes, f), prevPrices);
}

// ── KV ──────────────────────────────────────────────

/** 上市股票清單；KV 沒有就向證交所抓一次並存起來 */
export async function getUniverse(kv: KVNamespace, f: Fetch = fetch): Promise<StockName[]> {
  const cached = await kv.get<StockName[]>(K.universe, "json");
  if (cached && cached.length) return cached;
  const list = await fetchStockList(f);
  await kv.put(K.universe, JSON.stringify(list));
  return list;
}

export const getStatus = (kv: KVNamespace) => kv.get<CloseStatus>(K.status, "json");
export const getDays = async (kv: KVNamespace) => (await kv.get<string[]>(K.days, "json")) ?? [];
export const getClose = (kv: KVNamespace, date: string) => kv.get<CloseSnapshot>(K.close(date), "json");

export async function getLatestClose(kv: KVNamespace): Promise<CloseSnapshot | null> {
  const days = await getDays(kv);
  return days.length ? getClose(kv, days[0]) : null;
}

async function putStatus(kv: KVNamespace, s: CloseStatus): Promise<void> {
  await kv.put(K.status, JSON.stringify(s));
}

async function putClose(kv: KVNamespace, snap: CloseSnapshot): Promise<void> {
  await kv.put(K.close(snap.date), JSON.stringify(snap), { expirationTtl: CLOSE_TTL_SECONDS });
  const days = await getDays(kv);
  const next = [snap.date, ...days.filter((d) => d !== snap.date)].sort().reverse().slice(0, KEEP_DAYS);
  await kv.put(K.days, JSON.stringify(next));
}

// ── 收盤價排程 ──────────────────────────────────────

export interface CloseRunResult {
  stored: boolean;
  date: string | null;
  message: string;
}

/**
 * 抓收盤價並存起來（排程 14:30、14:40 各跑一次；14:40 那次如果今天已經存好就什麼都不做）。
 * - MIS 回傳的日期是今天 → 存成今天的收盤資料
 * - 不是今天（休市日）→ 標記今天休市；那一天的資料如果還沒存（例如第一次部署）就順便補存
 * retry：這是不是最後一次機會（14:40），失敗就標記 failed，頁面改顯示「收盤價暫時無法取得」
 */
export async function runCloseJob(env: { NEWS: KVNamespace }, opts: { now?: number; retry?: boolean; fetch?: Fetch; force?: boolean } = {}): Promise<CloseRunResult> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now();
  const today = taipeiTime(now).date;
  const kv = env.NEWS;

  if (!opts.force) {
    const st = await getStatus(kv);
    if (st && st.date === today && (st.state === "ok" || st.state === "holiday")) {
      return { stored: false, date: today, message: `今天已經處理過（${st.state}）` };
    }
  }

  try {
    // 每天更新一次股票清單（新上市的股票隔天會出現）；抓不到就沿用舊的
    let list: StockName[];
    try {
      list = await fetchStockList(f);
      await kv.put(K.universe, JSON.stringify(list));
    } catch {
      list = await getUniverse(kv, f);
    }
    const names = new Map(list);
    const rows = await fetchMis(list.map(([c]) => c), f);
    const live = buildLive(rows);
    if (!live.date || live.quotes.length < list.length * 0.9) throw new Error(`MIS 資料不完整（${live.quotes.length}/${list.length} 檔）`);

    // 加權指數：OpenAPI 的收盤值比較準；日期對不上（還沒更新）就用 MIS 的
    let index = live.index;
    try {
      const res = await f(INDEX_CLOSE_URL, { headers: UA, signal: AbortSignal.timeout(10_000) });
      const parsed = res.ok ? parseIndexClose(await res.json()) : null;
      if (parsed && parsed.date === live.date) index = parsed.quote;
    } catch {
      /* 沿用 MIS 的指數 */
    }

    const byCode = new Map(rows.map((r) => [r.code, r]));
    const quotes: CloseQuote[] = live.quotes.map(([code, price]) => {
      const row = byCode.get(code);
      const [change, pct] = changeOf(price, row?.prev ?? null);
      return [code, names.get(code) ?? row?.name ?? code, price, change, pct];
    });
    const topVolume = topVolumeOf(quotes, new Map(rows.map((r) => [r.code, r.volume])));
    const snap: CloseSnapshot = { date: live.date, fetchedAt: new Date(now).toISOString(), index, quotes, topVolume };

    if (live.date === today) {
      await putClose(kv, snap);
      await putStatus(kv, { date: today, state: "ok", at: new Date(now).toISOString() });
      return { stored: true, date: today, message: `已存 ${today} 收盤價（${quotes.length} 檔）` };
    }
    // 休市日：補存那一天（如果還沒有），並標記今天休市
    const had = await getClose(kv, live.date);
    if (!had) await putClose(kv, snap);
    const weekday = taipeiTime(now).weekday;
    if (weekday >= 1 && weekday <= 5) await putStatus(kv, { date: today, state: "holiday", at: new Date(now).toISOString() });
    return { stored: !had, date: live.date, message: had ? `今天休市（最近交易日 ${live.date} 已存過）` : `今天休市，已補存 ${live.date} 收盤價` };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await putStatus(kv, { date: today, state: opts.retry ? "failed" : "retry", at: new Date(now).toISOString(), error });
    throw new Error(`收盤價抓取失敗：${error}`);
  }
}
