import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleRequest } from "../src/api.ts";
import { LIVE_MAX_PER_IP, LIVE_MAX_SOCKETS, liveSlotsFull } from "../src/stocks/market.ts";
import type { Digest, Env } from "../src/types.ts";

const BASE = "https://news.test";

function fakeEnv(kv: Record<string, unknown> = {}, extra: Partial<Env> = {}) {
  const reads: string[] = [];
  const NEWS = {
    get: async (k: string) => {
      reads.push(k);
      return kv[k] ?? null;
    },
    put: async () => {},
  };
  return { reads, env: { NEWS, ...extra } as unknown as Env };
}

const digest = (): Digest => ({
  id: "20261108T0400Z",
  generatedAt: "2026-11-08T04:00:00.000Z",
  windowStart: "2026-11-07T23:00:00.000Z",
  windowEnd: "2026-11-08T04:00:00.000Z",
  summarizer: "workers-ai",
  model: "m",
  regions: {
    tw: { events: [], articleCount: 3, error: "Claude API 回應 500：內部訊息", sources: [{ name: "中央社", ok: false, count: 0, error: "HTTP 503 內部訊息" }] },
    world: { events: [], articleCount: 0, sources: [{ name: "BBC", ok: true, count: 0 }] },
  },
});

test("流量限制：超過就回 429，不會碰到 KV", async () => {
  const seen: string[] = [];
  const { env, reads } = fakeEnv({}, {
    API_LIMIT: { limit: async ({ key }: { key: string }) => (seen.push(key), { success: false }) } as unknown as RateLimit,
  });
  const res = await handleRequest(new Request(BASE + "/api/latest", { headers: { "cf-connecting-ip": "1.2.3.4" } }), env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(seen, ["1.2.3.4"]);
  assert.deepEqual(reads, []);
});

test("流量限制：沒綁定或限制服務出錯時放行", async () => {
  const none = fakeEnv();
  assert.equal((await handleRequest(new Request(BASE + "/api/digests"), none.env)).status, 200);
  const broken = fakeEnv({}, { API_LIMIT: { limit: async () => { throw new Error("x"); } } as unknown as RateLimit });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handleRequest(new Request(BASE + "/api/digests"), broken.env)).status, 200);
  } finally {
    console.error = original;
  }
});

test("短暫快取：連續讀同一份只讀一次 KV", async () => {
  const { env, reads } = fakeEnv({ latest: digest() });
  for (let i = 0; i < 5; i++) await handleRequest(new Request(BASE + "/api/latest"), env);
  assert.equal(reads.filter((k) => k === "latest").length, 1);
});

test("給訪客的摘要不含內部錯誤訊息，也保留「失敗」的狀態", async () => {
  const { env } = fakeEnv({ latest: digest() });
  const res = await handleRequest(new Request(BASE + "/api/latest"), env);
  const text = await res.text();
  assert.ok(!text.includes("內部訊息"));
  const j = JSON.parse(text);
  assert.equal(j.digest.regions.tw.error, "整理失敗");
  assert.equal(j.digest.regions.world.error, undefined);
  assert.equal(j.digest.regions.tw.sources[0].ok, false);
});

test("HEAD 比照 GET，但沒有內容", async () => {
  const { env } = fakeEnv();
  const res = await handleRequest(new Request(BASE + "/api/digests", { method: "HEAD" }), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("API 回應都帶 nosniff", async () => {
  const { env } = fakeEnv();
  const res = await handleRequest(new Request(BASE + "/api/nope"), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("/api/refresh：沒設定 token 回 404，token 錯回 401，不接受 GET", async () => {
  const post = (headers = {}) => new Request(BASE + "/api/refresh", { method: "POST", headers });
  assert.equal((await handleRequest(post(), fakeEnv().env)).status, 404);
  const { env } = fakeEnv({}, { REFRESH_TOKEN: "secret" });
  assert.equal((await handleRequest(post(), env)).status, 401);
  assert.equal((await handleRequest(post({ authorization: "Bearer wrong!" }), env)).status, 401);
  assert.equal((await handleRequest(new Request(BASE + "/api/refresh"), env)).status, 405);
});

test("盤中 WebSocket：Origin 不是本站或沒帶都拒絕，本站才轉給 Durable Object", async () => {
  let forwarded = 0;
  const STOCKS = {
    idFromName: () => "id",
    get: () => ({ fetch: async () => (forwarded++, new Response("ok")) }),
  };
  const { env } = fakeEnv({}, { STOCKS: STOCKS as unknown as Env["STOCKS"] });
  const ws = (headers: Record<string, string>) => new Request(BASE + "/api/stocks/live", { headers: { upgrade: "websocket", ...headers } });
  assert.equal((await handleRequest(ws({}), env)).status, 403);
  assert.equal((await handleRequest(ws({ origin: "https://evil.test" }), env)).status, 403);
  assert.equal(forwarded, 0);
  assert.equal((await handleRequest(ws({ origin: BASE }), env)).status, 200);
  assert.equal(forwarded, 1);
});

test("盤中連線上限", () => {
  assert.equal(liveSlotsFull(0, 0), false);
  assert.equal(liveSlotsFull(LIVE_MAX_SOCKETS - 1, LIVE_MAX_PER_IP - 1), false);
  assert.equal(liveSlotsFull(LIVE_MAX_SOCKETS, 0), true);
  assert.equal(liveSlotsFull(1, LIVE_MAX_PER_IP), true);
});

test("CSP 的雜湊和 index.html 的內嵌主題腳本一致", () => {
  // 瀏覽器解析 HTML 時會把換行統一成 \n，雜湊要照這個算
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const hash = createHash("sha256").update(scripts[0][1]).digest("base64");
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.ok(headers.includes(`'sha256-${hash}'`));
});
