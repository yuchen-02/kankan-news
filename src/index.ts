import { runPipeline } from "./pipeline.ts";
import type { Digest, DigestIndexEntry, Env } from "./types.ts";

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

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env).then(
        ({ digest: d }) => console.log(`digest ${d.id}: tw=${d.regions.tw.events.length} world=${d.regions.world.events.length}`),
        (e) => {
          console.error("digest failed:", e instanceof Error ? e.message : e);
          throw e;
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
