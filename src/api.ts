import { repairLatest, runPipeline } from "./pipeline.ts";
import { getInsight, runInsightJob } from "./stocks/insight.ts";
import { insightCheckAt, phaseAt, taipeiTime } from "./stocks/market.ts";
import { getClose, getDays, getLatestClose, getStatus, runCloseJob } from "./stocks/store.ts";
import type { Digest, DigestIndexEntry, Env, RegionDigest } from "./types.ts";

function json(data: unknown, init: ResponseInit = {}, cacheSeconds = 0): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** 比對 token（固定時間比較，避免時序攻擊） */
function tokenMatches(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── 讀取快取：同一個 Worker 實例短時間內不重複讀 KV，省免費額度（每天 10 萬次讀取）──

const MAX_CACHED = 50;
const readCaches = new WeakMap<object, Map<string, { until: number; value: Promise<unknown> }>>();

function cached<T>(kv: KVNamespace, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  let cache = readCaches.get(kv);
  if (!cache) readCaches.set(kv, (cache = new Map()));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value as Promise<T>;
  if (cache.size >= MAX_CACHED) cache.clear();
  const map = cache;
  const value = load().catch((e) => {
    map.delete(key); // 讀取失敗不留在快取裡
    throw e;
  });
  map.set(key, { until: now + ttlMs, value });
  return value;
}

/** 給訪客的摘要：拿掉內部錯誤訊息（KV 裡的原始資料保留，紀錄與補救流程要用） */
function publicDigest(d: Digest): Digest {
  const region = (r: RegionDigest): RegionDigest => ({
    ...r,
    ...(r.error ? { error: "整理失敗" } : {}),
    sources: r.sources.map(({ error: _error, ...s }) => s),
  });
  const { econNews: _econNews, ...rest } = d;
  return { ...rest, regions: { tw: region(d.regions.tw), world: region(d.regions.world) } };
}

/** 每個 IP 的流量限制（數值設定在 wrangler.jsonc）。沒綁定或限制服務出錯時放行，不讓它擋掉正常功能 */
async function overLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.API_LIMIT) return false;
  try {
    const { success } = await env.API_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    return !success;
  } catch (e) {
    console.error("rate limit:", e instanceof Error ? e.message : e);
    return false;
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "GET" : request.method;

  // 訪客計數：每次打開網頁加一（POST）；只接受從本站頁面送出的請求
  if (url.pathname === "/api/visit" || url.pathname === "/api/visits") {
    if (!env.COUNTER) return json({ error: "Not found" }, { status: 404 });
    const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
    if (url.pathname === "/api/visits") {
      return method === "GET" ? json({ count: await stub.get() }, {}, 30) : json({ error: "請使用 GET" }, { status: 405 });
    }
    if (method !== "POST") return json({ error: "請使用 POST" }, { status: 405 });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "Forbidden" }, { status: 403 });
    const who = request.headers.get("cf-connecting-ip") ?? "unknown";
    return json({ count: await stub.hit(who) });
  }

  // ── 台股 ──
  // 頁面打開時先問這個：現在是什麼狀態（盤中／收盤…）＋最近一天的收盤資料
  if (url.pathname === "/api/stocks" && method === "GET") {
    const now = Date.now();
    const [status, latest, insight] = await cached(env.NEWS, "stocks", 15_000, async () => {
      const [st, close] = await Promise.all([getStatus(env.NEWS), getLatestClose(env.NEWS)]);
      return [st, close, close ? await getInsight(env.NEWS, close.date) : null] as const;
    });
    const { phase, nextCheckAt } = phaseAt(now, status);
    const next = nextCheckAt ?? (phase === "closed" ? insightCheckAt(now, latest?.date ?? null, !!insight) : null);
    return json({ phase, nextCheckAt: next, today: taipeiTime(now).date, live: !!env.STOCKS, latest, insight });
  }

  if (url.pathname === "/api/stocks/days" && method === "GET") {
    return json({ days: await cached(env.NEWS, "stocks-days", 30_000, () => getDays(env.NEWS)) }, {}, 60);
  }

  if (url.pathname === "/api/stocks/day" && method === "GET") {
    const date = url.searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date 格式不正確" }, { status: 400 });
    const [snapshot, insight] = await cached(env.NEWS, `stocks-day:${date}`, 60_000, () => Promise.all([getClose(env.NEWS, date), getInsight(env.NEWS, date)]));
    return snapshot ? json({ snapshot, insight }, {}, 3600) : json({ error: "找不到這一天的收盤資料" }, { status: 404 });
  }

  // 盤中推送：WebSocket 連到 Durable Object；只接受從本站頁面連進來的（瀏覽器一定會帶 Origin）
  if (url.pathname === "/api/stocks/live") {
    if (!env.STOCKS) return json({ error: "Not found" }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "需要 WebSocket" }, { status: 426 });
    if (request.headers.get("origin") !== url.origin) return json({ error: "Forbidden" }, { status: 403 });
    return env.STOCKS.get(env.STOCKS.idFromName("tw")).fetch(request);
  }

  if (url.pathname === "/api/latest" && method === "GET") {
    const digest = await cached(env.NEWS, "latest", 30_000, () => env.NEWS.get<Digest>("latest", "json"));
    return json({ digest: digest && publicDigest(digest) }, {}, 60);
  }

  if (url.pathname === "/api/digests" && method === "GET") {
    const index = await cached(env.NEWS, "index", 30_000, async () => (await env.NEWS.get<DigestIndexEntry[]>("index", "json")) ?? []);
    return json({ digests: index }, {}, 60);
  }

  if (url.pathname === "/api/digest" && method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    if (!/^\d{8}T\d{4}Z$/.test(id)) return json({ error: "id 格式不正確" }, { status: 400 });
    const digest = await cached(env.NEWS, `digest:${id}`, 60_000, () => env.NEWS.get<Digest>(`digest:${id}`, "json"));
    return digest ? json({ digest: publicDigest(digest) }, {}, 3600) : json({ error: "找不到這份摘要" }, { status: 404 });
  }

  // 手動觸發一次（第一次部署後不想等排程時使用）。沒有設定 REFRESH_TOKEN 就完全不開放。
  if (url.pathname === "/api/refresh") {
    if (!env.REFRESH_TOKEN) return json({ error: "Not found" }, { status: 404 });
    if (method !== "POST") return json({ error: "請使用 POST" }, { status: 405 });
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!tokenMatches(given, env.REFRESH_TOKEN)) return json({ error: "Unauthorized" }, { status: 401 });
    // POST /api/refresh?stocks=1：立刻抓一次收盤價（第一次部署、或排程失敗後手動補抓）
    if (url.searchParams.get("stocks") === "1") {
      try {
        return json({ ok: true, ...(await runCloseJob(env, { force: true })) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    // POST /api/refresh?insight=1：立刻重新產生最新一天的收盤分析
    if (url.searchParams.get("insight") === "1") {
      try {
        return json({ ok: true, ...(await runInsightJob(env, { force: true })) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    // POST /api/refresh?repair=1：立刻補救最新一份有失敗區塊的摘要（不受 3 小時限制）
    if (url.searchParams.get("repair") === "1") {
      try {
        return json({ ok: true, ...(await repairLatest(env, { force: true })) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    try {
      // 手動觸發只預覽，不改變排程的時間軸；KV 還是空的時候才會儲存
      const { digest, stored } = await runPipeline(env, { persist: false });
      return json({
        ok: true,
        stored,
        note: stored ? "KV 裡原本沒有摘要，所以這份已儲存。" : "預覽：沒有儲存，不影響排程。",
        id: digest.id,
        events: { tw: digest.regions.tw.events.length, world: digest.regions.world.events.length },
        errors: { tw: digest.regions.tw.error ?? null, world: digest.regions.world.error ?? null },
        preview: {
          tw: digest.regions.tw.events.map((e) => e.headline),
          world: digest.regions.world.events.map((e) => e.headline),
        },
        sources: { tw: digest.regions.tw.sources, world: digest.regions.world.sources },
      });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  return json({ error: "Not found" }, { status: 404 });
}

/** 所有 Worker 請求的入口：先擋流量，HEAD 比照 GET 但不回內容 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (await overLimit(request, env)) {
    return json({ error: "請求太頻繁，請稍後再試" }, { status: 429, headers: { "retry-after": "60" } });
  }
  const res = await route(request, env);
  return request.method === "HEAD" ? new Response(null, res) : res;
}
