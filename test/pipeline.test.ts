import test from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../src/pipeline.ts";
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
