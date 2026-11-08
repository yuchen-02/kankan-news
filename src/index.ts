import { repairLatest, runPipeline, runScheduled } from "./pipeline.ts";
export { VisitCounter } from "./counter.ts";
export { StockHub } from "./stocks/hub.ts";
import { phaseAt, taipeiTime } from "./stocks/market.ts";
import { getClose, getDays, getLatestClose, getStatus, runCloseJob } from "./stocks/store.ts";
import type { Digest, DigestIndexEntry, Env } from "./types.ts";

/** 抓收盤價的排程（UTC 06:30、06:40 = 台北 14:30、14:40，週一到週五）；要和 wrangler.jsonc 裡的寫法一模一樣。
 *  （Worker 的主檔只能 export 處理函式與 Durable Object 類別，所以這裡不 export） */
const STOCK_CRON = "30,40 6 * * 1-5";

function json(data: unknown, init: ResponseInit = {}, cacheSeconds = 0): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store");
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 訪客計數：每次打開網頁加一（POST）；只接受從本站頁面送出的請求
    if (url.pathname === "/api/visit" || url.pathname === "/api/visits") {
      if (!env.COUNTER) return json({ error: "Not found" }, { status: 404 });
      const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
      if (url.pathname === "/api/visits") {
        return request.method === "GET" ? json({ count: await stub.get() }, {}, 30) : json({ error: "請使用 GET" }, { status: 405 });
      }
      if (request.method !== "POST") return json({ error: "請使用 POST" }, { status: 405 });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden" }, { status: 403 });
      const who = request.headers.get("cf-connecting-ip") ?? "unknown";
      return json({ count: await stub.hit(who) });
    }

    // ── 台股 ──
    // 頁面打開時先問這個：現在是什麼狀態（盤中／收盤…）＋最近一天的收盤資料
    if (url.pathname === "/api/stocks" && request.method === "GET") {
      const now = Date.now();
      const [status, latest] = await Promise.all([getStatus(env.NEWS), getLatestClose(env.NEWS)]);
      const { phase, nextCheckAt } = phaseAt(now, status);
      return json({ phase, nextCheckAt, today: taipeiTime(now).date, live: !!env.STOCKS, latest });
    }

    if (url.pathname === "/api/stocks/days" && request.method === "GET") {
      return json({ days: await getDays(env.NEWS) }, {}, 60);
    }

    if (url.pathname === "/api/stocks/day" && request.method === "GET") {
      const date = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date 格式不正確" }, { status: 400 });
      const snapshot = await getClose(env.NEWS, date);
      return snapshot ? json({ snapshot }, {}, 3600) : json({ error: "找不到這一天的收盤資料" }, { status: 404 });
    }

    // 盤中推送：WebSocket 連到 Durable Object；只接受從本站頁面連進來的
    if (url.pathname === "/api/stocks/live") {
      if (!env.STOCKS) return json({ error: "Not found" }, { status: 404 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "需要 WebSocket" }, { status: 426 });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden" }, { status: 403 });
      return env.STOCKS.get(env.STOCKS.idFromName("tw")).fetch(request);
    }

    if (url.pathname === "/api/latest" && request.method === "GET") {
      const digest = await env.NEWS.get<Digest>("latest", "json");
      return json({ digest }, {}, 60);
    }

    if (url.pathname === "/api/digests" && request.method === "GET") {
      const index = (await env.NEWS.get<DigestIndexEntry[]>("index", "json")) ?? [];
      return json({ digests: index }, {}, 60);
    }

    if (url.pathname === "/api/digest" && request.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^\d{8}T\d{4}Z$/.test(id)) return json({ error: "id 格式不正確" }, { status: 400 });
      const digest = await env.NEWS.get<Digest>(`digest:${id}`, "json");
      return digest ? json({ digest }, {}, 3600) : json({ error: "找不到這份摘要" }, { status: 404 });
    }

    // 手動觸發一次（第一次部署後不想等排程時使用）。沒有設定 REFRESH_TOKEN 就完全不開放。
    if (url.pathname === "/api/refresh") {
      if (!env.REFRESH_TOKEN) return json({ error: "Not found" }, { status: 404 });
      if (request.method !== "POST") return json({ error: "請使用 POST" }, { status: 405 });
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
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === STOCK_CRON) {
      // 14:40 那次是最後機會：再失敗就標記失敗
      const retry = new Date(event.scheduledTime).getUTCMinutes() === 40;
      ctx.waitUntil(
        runCloseJob(env, { now: event.scheduledTime, retry }).then(
          (r) => console.log("stocks:", r.message),
          (e) => {
            console.error(e instanceof Error ? e.message : e);
            throw e;
          },
        ),
      );
      return;
    }
    ctx.waitUntil(
      runScheduled(env, event.scheduledTime).then(
        (msg) => console.log(msg),
        (e) => {
          console.error("digest failed:", e instanceof Error ? e.message : e);
          throw e;
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
