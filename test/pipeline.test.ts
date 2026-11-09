import test from "node:test";
import assert from "node:assert/strict";
import { balanceQuota, moveForeignEvents, quotas, repairLatest, runPipeline, runScheduled } from "../src/pipeline.ts";
import type { ChosenSummarizer } from "../src/summarizers/index.ts";
import type { Digest, Env, SummarizeInput } from "../src/types.ts";

const NOW = new Date("2026-11-04T08:00:00Z");

function rss(items: { title: string; link: string; minutesAgo: number }[]): string {
  const body = items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${i.link}</link><description>${i.title} 的內文</description><pubDate>${new Date(
          NOW.getTime() - i.minutesAgo * 60_000,
        ).toUTCString()}</pubDate></item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${body}</channel></rss>`;
}

function fakeKV() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string, type?: string) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

const feeds = [
  { region: "tw" as const, name: "中央社", url: "https://cna.test/politics" },
  { region: "tw" as const, name: "中央社", url: "https://cna.test/social" },
  { region: "tw" as const, name: "公視新聞網", url: "https://pts.test/feed" },
  { region: "world" as const, name: "BBC", url: "https://bbc.test/world" },
  { region: "world" as const, name: "DW", url: "https://dw.test/broken" },
  { region: "world" as const, name: "NPR", url: "https://npr.test/empty" },
];

const fakeFetch = (async (url: string) => {
  if (url.includes("cna.test/politics"))
    return new Response(
      rss([
        { title: "颱風今晚登陸", link: "https://cna.test/p/1?ref=a", minutesAgo: 30 },
        { title: "舊聞不該出現", link: "https://cna.test/p/old", minutesAgo: 60 * 20 },
      ]),
    );
  if (url.includes("cna.test/social"))
    return new Response(rss([{ title: "颱風今晚登陸", link: "https://cna.test/p/1?ref=b", minutesAgo: 29 }]));
  if (url.includes("pts.test")) return new Response(rss([{ title: "颱風登陸 各地停班課", link: "https://pts.test/9", minutesAgo: 20 }]));
  if (url.includes("bbc.test")) return new Response(rss([{ title: "Summit ends", link: "https://bbc.test/s", minutesAgo: 90 }]));
  if (url.includes("dw.test")) return new Response("nope", { status: 503 });
  return new Response(rss([]));
}) as unknown as typeof fetch;

test("整條流程：去重、舊文過濾、來源失敗隔離、連結由程式帶入、寫入 KV", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const seen: SummarizeInput[] = [];

  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "fake-model",
    run: async (input) => {
      seen.push(input);
      if (input.region === "tw") {
        return [{ headline: "颱風登陸", summary: "中央氣象署表示……", disputed: null, articleIds: [1, 2, 3, 999] }];
      }
      return [{ headline: "高峰會結束", summary: "BBC 報導……", disputed: null, articleIds: [1], categories: ["外交", "經濟"] }];
    },
  };

  const { digest } = await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });

  // 台灣：同一篇（網址只差 query）去重，舊聞被濾掉 → 剩 2 篇
  const tw = seen.find((s) => s.region === "tw")!;
  assert.equal(tw.articles.length, 2);
  assert.ok(!tw.articles.some((a) => a.title.includes("舊聞")));
  assert.deepEqual(tw.articles.map((a) => a.id), [1, 2]);

  // 事件：只有兩個有效編號 → 兩個來源；999 被忽略
  assert.equal(digest.regions.tw.events.length, 1);
  assert.equal(digest.regions.tw.events[0].sourceCount, 2);
  assert.deepEqual(digest.regions.tw.events[0].sources.map((s) => s.name).sort(), ["中央社", "公視新聞網"]);

  // 世界：單一來源，且失敗的 DW、空的 NPR 被記錄
  assert.equal(digest.regions.world.events[0].sourceCount, 1);
  assert.deepEqual(digest.regions.world.events[0].categories, ["外交", "經濟"]);
  assert.equal(digest.regions.tw.events[0].categories, undefined);
  const dw = digest.regions.world.sources.find((s) => s.name === "DW")!;
  assert.equal(dw.ok, false);
  assert.match(dw.error ?? "", /503/);
  assert.equal(digest.regions.world.sources.find((s) => s.name === "NPR")!.ok, false);
  const bbc = digest.regions.world.sources.find((s) => s.name === "BBC")!;
  assert.equal(bbc.fetched, 1);
  assert.equal(bbc.newestAt, new Date(NOW.getTime() - 90 * 60_000).toISOString().replace(/\.\d+Z$/, ".000Z"));

  // 預設時間範圍 8 小時
  assert.equal(Date.parse(digest.windowEnd) - Date.parse(digest.windowStart), 8 * 3600_000);

  // KV
  const latest = JSON.parse(kv.m.get("latest")!) as Digest;
  assert.equal(latest.id, "20261104T0800Z");
  assert.ok(kv.m.has("digest:20261104T0800Z"));
  assert.equal(JSON.parse(kv.m.get("index")!).length, 1);
});

test("第二次執行：時間範圍從上一份摘要開始，index 累加", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const summarizer: ChosenSummarizer = { name: "fake", model: "m", run: async () => [] };

  await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });
  const later = new Date(NOW.getTime() + 8 * 3600_000);
  const { digest: d2 } = await runPipeline(env, { fetch: fakeFetch, now: later, summarizer, feeds });

  const span = Date.parse(d2.windowEnd) - Date.parse(d2.windowStart);
  assert.equal(span, 8 * 3600_000 + 10 * 60_000);
  assert.equal(JSON.parse(kv.m.get("index")!).length, 2);
});

test("兩個區塊都摘要失敗：丟錯，且不覆蓋上一份摘要", async () => {
  const kv = fakeKV();
  kv.m.set("latest", JSON.stringify({ id: "old", generatedAt: "2026-11-03T20:00:00.000Z" }));
  const env = { NEWS: kv } as unknown as Env;
  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "m",
    run: async () => {
      throw new Error("model down");
    },
  };
  await assert.rejects(runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds }), /兩個區塊都摘要失敗/);
  assert.equal(JSON.parse(kv.m.get("latest")!).id, "old");
});

test("只有一個區塊失敗：仍會存檔，錯誤記在該區塊", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "m",
    run: async (input) => {
      if (input.region === "world") throw new Error("bad json");
      return [{ headline: "h", summary: "s", disputed: null, articleIds: [1] }];
    },
  };
  const { digest: d } = await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });
  assert.equal(d.regions.tw.events.length, 1);
  assert.equal(d.regions.world.error, "bad json");
});

test("預覽模式：已有摘要時不寫入任何東西，排程時間軸不變", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const summarizer: ChosenSummarizer = { name: "fake", model: "m", run: async () => [{ headline: "h", summary: "s", disputed: null, articleIds: [1] }] };

  await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });
  const before = new Map(kv.m);

  const preview = await runPipeline(env, { fetch: fakeFetch, now: new Date(NOW.getTime() + 3 * 3600_000), summarizer, feeds, persist: false });
  assert.equal(preview.stored, false);
  assert.deepEqual([...kv.m.entries()], [...before.entries()]);

  // 之後的排程仍然從「上一份排程摘要」開始算
  const later = new Date(NOW.getTime() + 8 * 3600_000);
  const { digest: next } = await runPipeline(env, { fetch: fakeFetch, now: later, summarizer, feeds });
  assert.equal(Date.parse(next.windowStart), NOW.getTime() - 10 * 60_000);
});

test("預覽模式：KV 還沒有任何摘要時（第一次部署）仍會儲存", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const summarizer: ChosenSummarizer = { name: "fake", model: "m", run: async () => [] };
  const r = await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds, persist: false });
  assert.equal(r.stored, true);
  assert.ok(kv.m.has("latest"));
});

test("縮圖：優先用 RSS 圖；沒有就讀文章網頁的 og:image；都沒有就不放；有總量上限", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const mk = (title: string, link: string, extra = "") =>
    `<item><title>${title}</title><link>${link}</link><description>${title}</description><pubDate>${new Date(NOW.getTime() - 600_000).toUTCString()}</pubDate>${extra}</item>`;
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (url === "https://f.test/feed")
      return new Response(
        `<rss xmlns:media="m"><channel>${mk("有圖", "https://f.test/1", '<enclosure url="https://img.test/1.jpg" type="image/jpeg"/>')}${mk("頁面有圖", "https://f.test/2")}${mk("完全沒圖", "https://f.test/3")}</channel></rss>`,
      );
    if (url === "https://f.test/2") return new Response('<html><head><meta property="og:image" content="https://img.test/2.jpg"></head><body></body></html>');
    return new Response("<html><head></head></html>");
  }) as unknown as typeof fetch;

  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "m",
    run: async (input) =>
      input.region === "tw"
        ? input.articles.map((a) => ({ headline: a.title, summary: "s", disputed: null, articleIds: [a.id] }))
        : [],
  };
  const { digest } = await runPipeline(env, { fetch: f, now: NOW, summarizer, feeds: [{ region: "tw", name: "F", url: "https://f.test/feed" }] });
  const by = Object.fromEntries(digest.regions.tw.events.map((e) => [e.headline, e.imageUrl]));
  assert.equal(by["有圖"], "https://img.test/1.jpg");
  assert.equal(by["頁面有圖"], "https://img.test/2.jpg");
  assert.equal(by["完全沒圖"], undefined);
  assert.ok(!calls.includes("https://f.test/1"), "已有 RSS 圖就不必讀網頁");
});

test("縮圖：事件引用的不同文章各有圖時，最多留 2 張不重複的（imageUrls），第一張同時放在 imageUrl", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const mk = (title: string, link: string, img: string) =>
    `<item><title>${title}</title><link>${link}</link><description>${title}</description><pubDate>${new Date(NOW.getTime() - 600_000).toUTCString()}</pubDate><enclosure url="${img}" type="image/jpeg"/></item>`;
  const f = (async () =>
    new Response(
      `<rss><channel>${mk("甲", "https://f.test/a", "https://img.test/a.jpg")}${mk("乙", "https://f.test/b", "https://img.test/a.jpg")}${mk("丙", "https://f.test/c", "https://img.test/c.jpg")}${mk("丁", "https://f.test/d", "https://img.test/d.jpg")}</channel></rss>`,
    )) as unknown as typeof fetch;
  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "m",
    run: async (input) =>
      input.region === "tw"
        ? [
            { headline: "多圖", summary: "s", disputed: null, articleIds: input.articles.slice(0, 3).map((a) => a.id) },
            { headline: "單圖", summary: "s", disputed: null, articleIds: [input.articles[3].id] },
          ]
        : [],
  };
  const { digest } = await runPipeline(env, { fetch: f, now: NOW, summarizer, feeds: [{ region: "tw", name: "F", url: "https://f.test/feed" }] });
  const multi = digest.regions.tw.events.find((e) => e.headline === "多圖")!;
  assert.equal(multi.imageUrls?.length, 2);
  assert.equal(new Set(multi.imageUrls).size, 2);
  assert.equal(multi.imageUrl, multi.imageUrls![0]);
  const single = digest.regions.tw.events.find((e) => e.headline === "單圖")!;
  assert.equal(single.imageUrls, undefined);
  assert.ok(single.imageUrl);
});

// ── 台灣來源裡的國外新聞 ───────────────────────────

const ev = (headline: string, urls: string[]) => ({
  headline,
  summary: "s",
  disputed: null,
  sources: urls.map((u, i) => ({ name: "S" + i, url: u, title: headline })),
  sourceCount: urls.length,
});
const worldOf = (events: ReturnType<typeof ev>[], extra: object = {}) => ({ events, sources: [], articleCount: 5, ...extra });

test("moveForeignEvents：移到世界頁最後面；同一篇文章（相同網址）已經在世界頁就不重複放", () => {
  const world = worldOf([ev("A", ["https://x/a"])]);
  const moved = moveForeignEvents(world, [ev("B", ["https://x/b"]), ev("A2", ["https://x/a", "https://x/z"])], 8);
  assert.equal(moved, 1);
  assert.deepEqual(world.events.map((e) => e.headline), ["A", "B"]);
});

test("moveForeignEvents：世界頁滿了、或世界頁那一輪失敗／沒有文章，就不硬塞", () => {
  const full = worldOf([ev("A", ["https://x/a"]), ev("B", ["https://x/b"])]);
  assert.equal(moveForeignEvents(full, [ev("C", ["https://x/c"])], 2), 0);
  assert.equal(full.events.length, 2);
  const failed = worldOf([], { error: "boom" });
  assert.equal(moveForeignEvents(failed, [ev("C", ["https://x/c"])], 8), 0);
  const empty = worldOf([], { articleCount: 0 });
  assert.equal(moveForeignEvents(empty, [ev("C", ["https://x/c"])], 8), 0);
});

test("流程：台灣那一輪標成 foreign 的事件，出現在世界頁、不在台灣頁", async () => {
  const kv = fakeKV();
  const env = { NEWS: kv } as unknown as Env;
  const mk = (title: string, link: string) =>
    `<item><title>${title}</title><link>${link}</link><description>${title}</description><pubDate>${new Date(NOW.getTime() - 600_000).toUTCString()}</pubDate></item>`;
  const f = (async (url: string) =>
    url === "https://tw.test/feed"
      ? new Response(`<rss><channel>${mk("台灣的事", "https://tw.test/1")}${mk("法國的事", "https://tw.test/2")}</channel></rss>`)
      : new Response(`<rss><channel>${mk("世界的事", "https://w.test/1")}</channel></rss>`)) as unknown as typeof fetch;
  const summarizer: ChosenSummarizer = {
    name: "fake",
    model: "m",
    run: async (input) =>
      input.region === "tw"
        ? [
            { headline: "台灣的事", summary: "s", disputed: null, articleIds: [1] },
            { headline: "法國的事", summary: "s", disputed: null, articleIds: [2], foreign: true },
          ]
        : [{ headline: "世界的事", summary: "s", disputed: null, articleIds: [1] }],
  };
  const feeds = [
    { region: "tw" as const, name: "T", url: "https://tw.test/feed" },
    { region: "world" as const, name: "W", url: "https://w.test/feed" },
  ];
  const { digest } = await runPipeline(env, { fetch: f, now: NOW, summarizer, feeds });
  assert.deepEqual(digest.regions.tw.events.map((e) => e.headline), ["台灣的事"]);
  assert.deepEqual(digest.regions.world.events.map((e) => e.headline), ["世界的事", "法國的事"]);
});

const mk = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ev(`${tag}${i}`, [`https://x/${tag}${i}`]));

test("balanceQuota：台灣不滿，名額讓給世界；兩區合計不超過總額", () => {
  const tw = worldOf(mk(3, "t"));
  const world = worldOf(mk(12, "w"));
  balanceQuota(tw, world, [], { tw: 8, world: 8 });
  assert.equal(tw.events.length, 3);
  assert.equal(world.events.length, 12);
});

test("balanceQuota：世界不滿，名額讓給台灣；兩邊都滿就各自 8 則", () => {
  const tw = worldOf(mk(12, "t"));
  const world = worldOf(mk(2, "w"));
  balanceQuota(tw, world, [], { tw: 8, world: 8 });
  assert.equal(tw.events.length, 12);
  assert.equal(world.events.length, 2);
  const a = worldOf(mk(12, "t")), b = worldOf(mk(12, "w"));
  balanceQuota(a, b, [], { tw: 8, world: 8 });
  assert.deepEqual([a.events.length, b.events.length], [8, 8]);
});

test("balanceQuota：國外新聞搬過去也算世界的名額，保留較重要（排前面）的", () => {
  const tw = worldOf(mk(2, "t"));
  const world = worldOf(mk(8, "w"));
  balanceQuota(tw, world, mk(10, "f"), { tw: 8, world: 8 });
  assert.equal(tw.events.length, 2);
  assert.equal(world.events.length, 14);
  assert.equal(world.events[0].headline, "w0");
});

test("quotas：沒設定用 8，可由環境變數調整", () => {
  assert.deepEqual(quotas({}), { tw: 8, world: 8, total: 16, ask: 11 });
  assert.deepEqual(quotas({ MAX_EVENTS_TW: "5", MAX_EVENTS_WORLD: "10" }), { tw: 5, world: 10, total: 15, ask: 11 });
  assert.equal(quotas({ MAX_EVENTS_ASK: "3" }).ask, 8); // 不低於基本名額
  assert.equal(quotas({ MAX_EVENTS_ASK: "99" }).ask, 16); // 不超過總額
});

test("流程：同一篇文章只會出現在一則事件裡", async () => {
  const summarizer: ChosenSummarizer = {
    name: "fake", model: "m",
    run: async (i: SummarizeInput) =>
      i.region === "tw"
        ? [
            { headline: "A", summary: "s", disputed: null, articleIds: [1], categories: [] },
            { headline: "B", summary: "s", disputed: null, articleIds: [1], categories: [] },
            { headline: "C", summary: "s", disputed: null, articleIds: [1, 2], categories: [] },
          ]
        : [],
  };
  const env = { NEWS: fakeKV() } as unknown as Env;
  const { digest } = await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });
  const heads = digest.regions.tw.events.map((e) => e.headline);
  assert.deepEqual(heads, ["A", "C"]);
  const urls = digest.regions.tw.events.flatMap((e) => e.sources.map((s) => s.url));
  assert.equal(new Set(urls).size, urls.length);
});

test("流程：每區向 AI 要的是 MAX_EVENTS_ASK（預設 11），不是兩區總額", async () => {
  const asked: number[] = [];
  const summarizer: ChosenSummarizer = { name: "fake", model: "m", run: async (i: SummarizeInput) => { asked.push(i.maxEvents); return []; } };
  const env = { NEWS: fakeKV() } as unknown as Env;
  await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer, feeds });
  assert.deepEqual(asked, [11, 11]);
});

// ── 補救：有區塊失敗時重做，成功就原地換掉 ──
const okEvent = [{ headline: "好", summary: "s", disputed: null, articleIds: [1], categories: [] }];
const sumWorldFails: ChosenSummarizer = { name: "fake", model: "m", run: async (i: SummarizeInput) => { if (i.region === "world") throw new Error("Unexpected token ]"); return okEvent; } };
const sumAllOk: ChosenSummarizer = { name: "fake", model: "m", run: async () => okEvent };

test("repairLatest：世界失敗後補救成功，同一個 id、原地換掉", async () => {
  const env = { NEWS: fakeKV() } as unknown as Env;
  const first = await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer: sumWorldFails, feeds });
  assert.ok(first.digest.regions.world.error);
  const r = await repairLatest(env, { fetch: fakeFetch, now: new Date(NOW.getTime() + 20 * 60_000), summarizer: sumAllOk, feeds });
  assert.equal(r.repaired, true);
  const latest = (await env.NEWS.get("latest", "json")) as any;
  assert.equal(latest.id, first.digest.id);
  assert.equal(latest.regions.world.error, undefined);
  assert.ok(latest.regions.world.events.length > 0);
  const index = (await env.NEWS.get("index", "json")) as any[];
  assert.equal(index.length, 1);
  assert.ok(index[0].counts.world > 0);
});

test("repairLatest：重做仍失敗就保留原樣；沒失敗或太舊就不動", async () => {
  const env = { NEWS: fakeKV() } as unknown as Env;
  await runPipeline(env, { fetch: fakeFetch, now: NOW, summarizer: sumWorldFails, feeds });
  const again = await repairLatest(env, { fetch: fakeFetch, now: new Date(NOW.getTime() + 60_000), summarizer: sumWorldFails, feeds });
  assert.equal(again.repaired, false);
  const old = await repairLatest(env, { fetch: fakeFetch, now: new Date(NOW.getTime() + 4 * 3600_000), summarizer: sumAllOk, feeds });
  assert.equal(old.repaired, false);
  assert.match(old.reason, /3 小時/);
  const forced = await repairLatest(env, { fetch: fakeFetch, now: new Date(NOW.getTime() + 4 * 3600_000), summarizer: sumAllOk, feeds, force: true });
  assert.equal(forced.repaired, true);
  const healthy = await repairLatest(env, { fetch: fakeFetch, now: NOW, summarizer: sumAllOk, feeds });
  assert.equal(healthy.repaired, false);
});

test("runScheduled：整點正式整理；補救時段依狀況重做、補救或略過", async () => {
  const env = { NEWS: fakeKV() } as unknown as Env;
  const hour = Math.floor(NOW.getTime() / 3600_000) * 3600_000;
  const deps = { fetch: fakeFetch, now: NOW, summarizer: sumWorldFails, feeds };
  assert.match(await runScheduled(env, hour, deps), /^digest /);
  // :20 這個整點的摘要有世界失敗 → 補救
  assert.match(await runScheduled(env, hour + 20 * 60_000, { ...deps, summarizer: sumAllOk }), /已補救成功/);
  // :50 已經正常 → 略過
  assert.match(await runScheduled(env, hour + 50 * 60_000, { ...deps, summarizer: sumAllOk }), /沒有失敗/);
  // 另一個整點完全沒有摘要（整點整理時兩區都失敗）→ :20 整個重做
  const next = hour + 6 * 3600_000;
  assert.match(await runScheduled(env, next + 20 * 60_000, { ...deps, now: new Date(next + 20 * 60_000), summarizer: sumAllOk }), /^retry digest /);
});
