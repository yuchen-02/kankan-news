import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLive,
  insightCheckAt,
  liveBackoffMs,
  topVolumeOf,
  changeOf,
  diffQuotes,
  isMarketHours,
  isStockCode,
  misBatches,
  parseIndexClose,
  parseMis,
  parseStockList,
  phaseAt,
  rocDate,
  taipeiMs,
  taipeiTime,
  type CloseSnapshot,
  type CloseStatus,
  type LiveQuote,
} from "../src/stocks/market.ts";
import { fetchMis, runCloseJob } from "../src/stocks/store.ts";
import { advanceStreaks, buildFacts, collectHeadlines, runInsightJob, validateInsight } from "../src/stocks/insight.ts";
import type { Env } from "../src/types.ts";
// @ts-ignore 前端用的純 JS 模組
import * as lib from "../public/stocks-lib.js";

// 2026-11-09 是週一
const at = (hhmm: string, date = "2026-11-09") => {
  const [h, m] = hhmm.split(":").map(Number);
  return taipeiMs(date, h * 60 + m);
};

test("taipeiTime：UTC 換成台北日期、星期、分鐘", () => {
  const t = taipeiTime(Date.UTC(2026, 10, 9, 1, 30)); // 台北 09:30
  assert.equal(t.date, "2026-11-09");
  assert.equal(t.weekday, 1);
  assert.equal(t.minutes, 9 * 60 + 30);
  // UTC 前一天 16:00 = 台北隔天 00:00
  assert.equal(taipeiTime(Date.UTC(2026, 10, 8, 16, 0)).date, "2026-11-09");
});

test("isMarketHours：週一到週五 09:00–13:30", () => {
  assert.equal(isMarketHours(at("08:59")), false);
  assert.equal(isMarketHours(at("09:00")), true);
  assert.equal(isMarketHours(at("13:29")), true);
  assert.equal(isMarketHours(at("13:30")), false);
  assert.equal(isMarketHours(at("10:00", "2026-11-08")), false); // 週日
});

test("phaseAt：一天裡的各個狀態", () => {
  const ok: CloseStatus = { date: "2026-11-09", state: "ok", at: "" };
  const failed: CloseStatus = { date: "2026-11-09", state: "failed", at: "" };
  const retry: CloseStatus = { date: "2026-11-09", state: "retry", at: "" };
  const old: CloseStatus = { date: "2026-11-06", state: "ok", at: "" };
  assert.equal(phaseAt(at("08:00"), old).phase, "pre");
  assert.equal(phaseAt(at("08:00"), old).nextCheckAt, at("09:00"));
  assert.equal(phaseAt(at("10:00"), old).phase, "live");
  assert.equal(phaseAt(at("13:30"), old).phase, "after");
  assert.equal(phaseAt(at("14:31"), old).phase, "fetching"); // 昨天的狀態不算
  assert.equal(phaseAt(at("14:35"), retry).phase, "fetching");
  assert.equal(phaseAt(at("14:35"), ok).phase, "closed");
  assert.equal(phaseAt(at("14:41"), failed).phase, "failed");
  assert.equal(phaseAt(at("15:30"), null).phase, "failed"); // 排程沒跑
  assert.equal(phaseAt(at("20:00"), ok).phase, "closed");
  assert.equal(phaseAt(at("10:00", "2026-11-08"), old).phase, "closed"); // 週日
  assert.equal(phaseAt(at("10:00"), { date: "2026-11-09", state: "holiday", at: "" }).phase, "closed");
});

test("isStockCode／parseStockList：只留股票與 ETF，依代號排序", () => {
  assert.deepEqual(["2330", "0050", "00400A", "00632R", "01001T", "020000", "2330A"].map(isStockCode), [true, true, true, true, false, false, false]);
  const list = parseStockList([
    { Code: "2330", Name: "台積電" },
    { Code: "0050", Name: "元大台灣50" },
    { Code: "01001T", Name: "受益證券" },
    { Code: "2330", Name: "重複" },
  ]);
  assert.deepEqual(list, [["0050", "元大台灣50"], ["2330", "台積電"]]);
});

test("misBatches：加權指數放第一批，每批不超過上限", () => {
  const codes = Array.from({ length: 300 }, (_, i) => String(1000 + i));
  const b = misBatches(codes, 135);
  assert.equal(b.length, 3);
  assert.equal(b[0][0], "tse_t00.tw");
  assert.ok(b.every((x) => x.length <= 135));
  assert.equal(b.flat().length, 301);
});

test("parseMis：z 是 '-' 時改用 trade.z；查不到的代號略過", () => {
  const rows = parseMis({
    msgArray: [
      { c: "2330", n: "台積電", z: "2135.0000", y: "2240.0000", d: "20261106", t: "13:30:00" },
      { c: "0050", n: "元大台灣50", z: "-", trade: { z: "92.5000" }, y: "97.1500", d: "20261106", t: "13:30:00" },
      { c: "9999", n: "沒成交", z: "-", y: "10.00", d: "20261106" },
      { c: "", z: "-" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].price, 2135);
  assert.equal(rows[0].date, "2026-11-06");
  assert.equal(rows[1].price, 92.5);
  assert.equal(rows[2].price, null);
});

test("changeOf：漲跌與漲跌幅（兩位小數）", () => {
  assert.deepEqual(changeOf(2135, 2240), [-105, -4.69]);
  assert.deepEqual(changeOf(null, 10), [null, null]);
  assert.deepEqual(changeOf(10, 10), [0, 0]);
});

test("buildLive：指數分開放、沒成交沿用上一次的價格、依代號排序", () => {
  const live = buildLive(
    [
      { code: "t00", name: "加權", price: 39690.74, prev: 41574.72, date: "2026-11-06", time: "13:19:50", volume: null },
      { code: "2330", name: "台積電", price: null, prev: 2240, date: "2026-11-06", time: "13:30:00", volume: null },
      { code: "0050", name: "元大台灣50", price: 92.5, prev: 97.15, date: "2026-11-06", time: "13:30:00", volume: null },
    ],
    new Map([["2330", 2135]]),
  );
  assert.equal(live.index?.value, 39690.74);
  assert.equal(live.time, "13:30:00");
  assert.deepEqual(live.quotes.map((q) => q[0]), ["0050", "2330"]);
  assert.equal(live.quotes[1][1], 2135);
});

test("diffQuotes：只回傳有變的", () => {
  const prev = new Map<string, LiveQuote>([["2330", ["2330", 10, 1, 10]], ["0050", ["0050", 5, 0, 0]]]);
  const d = diffQuotes(prev, [["2330", 10, 1, 10], ["0050", 5.05, 0.05, 1], ["1101", 30, 0, 0]]);
  assert.deepEqual(d.map((q) => q[0]), ["0050", "1101"]);
});

test("parseIndexClose／rocDate：OpenAPI 的加權指數收盤", () => {
  assert.equal(rocDate("1151106"), "2026-11-06");
  const r = parseIndexClose([
    { 日期: "1151106", 指數: "發行量加權股價報酬指數", 收盤指數: "91806.06" },
    { 日期: "1151106", 指數: "發行量加權股價指數", 收盤指數: "39701.64", 漲跌: "-", 漲跌點數: "1,873.08", 漲跌百分比: "-4.51" },
  ]);
  assert.deepEqual(r, { date: "2026-11-06", quote: { value: 39701.64, change: -1873.08, pct: -4.51 } });
});

// ── 收盤價排程（假的證交所＋假的 KV）──

function fakeKv() {
  const m = new Map<string, string>();
  const kv = {
    get: async (k: string, type?: string) => {
      const v = m.get(k);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
  };
  return { kv: kv as unknown as KVNamespace, m };
}

function fakeTwse(misDate: string, opts: { failMis?: boolean } = {}) {
  const list = Array.from({ length: 600 }, (_, i) => ({ Code: String(1100 + i), Name: "股" + i }));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("STOCK_DAY_ALL")) return Response.json(list);
    if (url.includes("MI_INDEX")) return Response.json([{ 日期: "1151109", 指數: "發行量加權股價指數", 收盤指數: "40000", 漲跌: "+", 漲跌點數: "100", 漲跌百分比: "0.25" }]);
    if (url.includes("getStockInfo")) {
      if (opts.failMis) return new Response("blocked", { status: 403 });
      const chs = decodeURIComponent(new URL(url).searchParams.get("ex_ch") ?? "").split("|");
      const d = misDate.replace(/-/g, "");
      return Response.json({
        rtcode: "0000",
        msgArray: chs.map((ch) => {
          const c = ch.replace(/^tse_/, "").replace(/\.tw$/, "");
          return { c, n: c, z: "10.5", y: "10", d, t: "13:30:00" };
        }),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("runCloseJob：交易日存下今天的收盤價，第二次（14:40）不重抓", async () => {
  const { kv, m } = fakeKv();
  const now = at("14:30");
  const r = await runCloseJob({ NEWS: kv }, { now, fetch: fakeTwse("2026-11-09") });
  assert.equal(r.stored, true);
  const snap = JSON.parse(m.get("stocks:close:2026-11-09")!);
  assert.equal(snap.quotes.length, 600);
  assert.deepEqual(snap.quotes[0], ["1100", "股0", 10.5, 0.5, 5]);
  assert.equal(snap.index.value, 40000); // OpenAPI 日期對得上，用它的值
  assert.deepEqual(JSON.parse(m.get("stocks:days")!), ["2026-11-09"]);
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "ok");
  const again = await runCloseJob({ NEWS: kv }, { now: at("14:40"), retry: true, fetch: fakeTwse("2026-11-09", { failMis: true }) });
  assert.equal(again.stored, false);
});

test("runCloseJob：休市日標記 holiday，並補存最近交易日", async () => {
  const { kv, m } = fakeKv();
  await runCloseJob({ NEWS: kv }, { now: at("14:30"), fetch: fakeTwse("2026-11-06") });
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "holiday");
  assert.ok(m.has("stocks:close:2026-11-06"));
  assert.equal(phaseAt(at("15:00"), JSON.parse(m.get("stocks:status")!)).phase, "closed");
});

test("runCloseJob：14:30 失敗記成 retry，14:40 再失敗記成 failed", async () => {
  const { kv, m } = fakeKv();
  await assert.rejects(runCloseJob({ NEWS: kv }, { now: at("14:30"), fetch: fakeTwse("2026-11-09", { failMis: true }) }));
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "retry");
  await assert.rejects(runCloseJob({ NEWS: kv }, { now: at("14:40"), retry: true, fetch: fakeTwse("2026-11-09", { failMis: true }) }));
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "failed");
});

// ── 前端純函式 ──

test("stocks-lib：格式化", () => {
  assert.equal(lib.fmtDay("2026-11-06"), "11/6（五）");
  assert.equal(lib.fmtPrice(2135), "2,135");
  assert.equal(lib.fmtPrice(92.5), "92.50");
  assert.equal(lib.fmtPrice(null), "—");
  assert.equal(lib.fmtChange(-105), "-105");
  assert.equal(lib.fmtChange(0.05), "+0.05");
  assert.equal(lib.fmtChange(-8.3, 203.2), "-8.30");
  assert.equal(lib.fmtChange(-105, 2135), "-105");
  assert.equal(lib.fmtChange(0, 50), "0");
  assert.equal(lib.fmtPct(-4.69), "-4.69%");
  assert.equal(lib.fmtPct(0), "0.00%");
  assert.deepEqual([1, -1, 0, null].map(lib.trendOf), ["up", "down", "flat", "flat"]);
});

test("stocks-lib：盤中資料套用到收盤資料上，名稱保留", () => {
  const rows = lib.rowsFromClose([["2330", "台積電", 2135, -105, -4.69]]);
  lib.applyLive(rows, [["2330", 2140, -100, -4.46], ["9999", 1, 0, 0]]);
  assert.deepEqual(rows.get("2330"), { code: "2330", name: "台積電", price: 2140, change: -100, pct: -4.46 });
  assert.equal(rows.get("9999").name, "9999");
});

test("stocks-lib：搜尋與排序（沒有漲跌幅的排最後）", () => {
  const list = [
    { code: "2330", name: "台積電", pct: -1 },
    { code: "0050", name: "元大台灣50", pct: 2 },
    { code: "1101", name: "台泥", pct: null },
    { code: "2317", name: "鴻海", pct: 0.5 },
  ];
  assert.deepEqual(lib.filterRows(list, " 台 ").map((r: any) => r.code), ["2330", "0050", "1101"]);
  assert.deepEqual(lib.filterRows(list, "23").map((r: any) => r.code), ["2330", "2317"]);
  assert.deepEqual(lib.sortRows(list, "code").map((r: any) => r.code), ["0050", "1101", "2317", "2330"]);
  assert.deepEqual(lib.sortRows(list, "pct-desc").map((r: any) => r.code), ["0050", "2317", "2330", "1101"]);
  assert.deepEqual(lib.sortRows(list, "pct-asc").map((r: any) => r.code), ["2330", "2317", "0050", "1101"]);
  assert.equal(lib.nextPctSort("code"), "pct-desc");
  assert.equal(lib.nextPctSort("pct-desc"), "pct-asc");
});

test("stocks-lib：顏色模式與虛擬捲動範圍", () => {
  assert.equal(lib.resolveColors(null), "tw");
  assert.equal(lib.resolveColors("us"), "us");
  assert.equal(lib.colorsLabel("tw"), "紅漲綠跌");
  assert.equal(lib.colorsLabel("us"), "綠漲紅跌");
  assert.deepEqual(lib.visibleRange(200, 800, 44, 1000, 0), { start: 0, end: 14 }); // 清單還在畫面下方
  assert.deepEqual(lib.visibleRange(-4400, 880, 44, 1000, 2), { start: 98, end: 122 });
  assert.deepEqual(lib.visibleRange(-44000, 880, 44, 1000, 2).end, 1000);
});

test("stocks-lib：狀態文字", () => {
  const snap = { date: "2026-11-06" };
  assert.equal(lib.statusText({ phase: "pre", snap }), "尚未開盤 · 顯示 11/6（五） 收盤價");
  assert.equal(lib.statusText({ phase: "live", snap, live: { status: "live", time: "10:01:05" } }), "盤中 · 10:01:05 更新");
  assert.equal(lib.statusText({ phase: "fetching", snap }), "正在抓取收盤價，請稍後");
  assert.equal(lib.statusText({ phase: "failed", snap }), "收盤價暫時無法取得 · 顯示最後成交價");
  assert.equal(lib.statusText({ phase: "live", snap, live: { status: "holiday" } }), "今日休市 · 顯示 11/6（五） 收盤價");
  assert.equal(lib.statusText({ phase: "closed", snap: null }), "還沒有收盤資料");
  assert.equal(lib.wantsLive("after"), true);
  assert.equal(lib.wantsLive("closed"), false);
});

test("nextCheckDelay：失敗時退避（不會因為 nextCheckAt 過期而每秒重試），成功時等到下一個時間點", () => {
  const now = 1_000_000;
  assert.equal(lib.nextCheckDelay(now - 60_000, now, 1), 30_000);
  assert.equal(lib.nextCheckDelay(now - 60_000, now, 2), 60_000);
  assert.equal(lib.nextCheckDelay(null, now, 1), 30_000);
  assert.equal(lib.nextCheckDelay(now - 60_000, now, 20), 300_000);
  assert.equal(lib.nextCheckDelay(now + 10_000, now, 0), 11_500);
  assert.equal(lib.nextCheckDelay(now - 60_000, now, 0), 1_000);
  assert.equal(lib.nextCheckDelay(null, now, 0), null);
});

// ── 盤中連線 ──

test("liveBackoffMs：失敗後等 5、10、20… 秒，最長一分鐘", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => liveBackoffMs(5_000, n)), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.equal(liveBackoffMs(60_000, 1), 60_000);
});

test("fetchMis：單批 5xx 或連線中斷會重試一次；成功就不算失敗", async () => {
  for (const fail of [() => new Response("x", { status: 502 }), () => { throw new Error("network"); }]) {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) return fail();
      return new Response(JSON.stringify({ rtcode: "0000", msgArray: [{ c: "2330", z: "100", y: "99", v: "1200", d: "20261109" }] }));
    }) as typeof fetch;
    const rows = await fetchMis([], f);
    assert.equal(calls, 2);
    assert.equal(rows[0].volume, 1200);
  }
});

test("fetchMis：重試後還是失敗就丟錯；4xx 不重試", async () => {
  let calls = 0;
  await assert.rejects(fetchMis([], (async () => (calls++, new Response("x", { status: 520 }))) as typeof fetch), /MIS HTTP 520/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(fetchMis([], (async () => (calls++, new Response("x", { status: 403 }))) as typeof fetch), /MIS HTTP 403/);
  assert.equal(calls, 1);
});

// ── 收盤分析 ──

const SNAP: CloseSnapshot = {
  date: "2026-11-09",
  fetchedAt: "2026-11-09T06:30:00.000Z",
  index: { value: 41661.7, change: 1960.06, pct: 4.94 },
  quotes: [
    ["0050", "元大台灣50", 100, 2, 2.04],
    ["2330", "台積電", 2235, 100, 4.68],
    ["2464", "盟立", 148.5, 13.5, 10],
    ["4771", "望隼", 180, -20, -10],
    ["1101", "台泥", 30, 0, 0],
    ["9999", "沒成交", null, null, null],
  ],
  volumeEtf: [["0050", "元大台灣50", 9000, 2.04]],
  volumeStock: [["2330", "台積電", 41343, 4.68]],
};

test("topVolumeOf：ETF 與個股分開排，沒有量的不列", () => {
  const top = topVolumeOf(SNAP.quotes, new Map([["2330", 500], ["2464", 900], ["4771", null], ["0050", 100]]));
  assert.deepEqual(top.etf.map((r) => [r[0], r[2]]), [["0050", 100]]);
  assert.deepEqual(top.stock.map((r) => [r[0], r[2]]), [["2464", 900], ["2330", 500]]);
});

test("advanceStreaks：同方向累加、反向重算、平盤或沒成交歸零", () => {
  const day1 = advanceStreaks(null, SNAP);
  assert.equal(day1.index, 1);
  assert.deepEqual(day1.stocks, { "0050": 1, "2330": 1, "2464": 1, "4771": -1, "1101": 0, "9999": 0 });
  const next: CloseSnapshot = {
    ...SNAP,
    date: "2026-11-10",
    index: { value: 1, change: -5, pct: -1 },
    quotes: [["2330", "台積電", 1, 3, 1], ["2464", "盟立", 1, -1, -1], ["4771", "望隼", 1, -2, -1], ["1101", "台泥", 1, null, null]],
  };
  const day2 = advanceStreaks(day1, next);
  assert.equal(day2.index, -1);
  assert.deepEqual(day2.stocks, { "2330": 2, "2464": -1, "4771": -2, "1101": 0 });
});

test("buildFacts：家數、排行與連續最久（至少 3 天，同天數比今日漲跌幅）", () => {
  const streaks = { date: SNAP.date, index: 2, stocks: { "0050": 3, "2330": 3, "2464": 2, "4771": -4, "1101": 0 } };
  const f = buildFacts(SNAP, streaks);
  assert.deepEqual(f.breadth, { up: 3, down: 1, flat: 1, none: 1 });
  assert.deepEqual(f.gainers.map((r) => r[0]), ["2464", "2330", "0050"]);
  assert.deepEqual(f.losers.map((r) => r[0]), ["4771"]);
  assert.deepEqual(f.streaks.up.map((r) => [r[0], r[2]]), [["2330", 3], ["0050", 3]]);
  assert.deepEqual(f.streaks.down.map((r) => [r[0], r[2]]), [["4771", 4]]);
  assert.equal(f.streaks.index, 2);
});

test("validateInsight：擋數字、因果與建議用語、不在標題裡的事件", () => {
  const f = buildFacts(SNAP, { date: SNAP.date, index: 2, stocks: { "2330": 3 } });
  const heads = ["央行宣布利率維持不變", "美國加密貨幣價格大幅下跌"];
  const good = "台積電已連漲 3 天，ETF 成交量相對集中。今日新聞提到央行宣布利率維持不變，可留意後續影響。";
  assert.equal(validateInsight(good, f, heads), null);
  assert.equal(validateInsight("台積電已連漲 3 天，上漲家數明顯多於下跌家數，個股表現分歧不大。", f), null);
  assert.match(validateInsight("台積電已連漲 99 天，上漲家數明顯多於下跌家數，個股表現分歧。", f) ?? "", /99/);
  assert.match(validateInsight(good + "這是美股帶動的結果。", f, heads) ?? "", /帶動/);
  assert.match(validateInsight(good + "建議投資人減少持股部位。", f, heads) ?? "", /建議/);
  assert.match(validateInsight(good + "這可能對公司營運有幫助。", f, heads) ?? "", /可能/);
  assert.match(validateInsight("台積電已連漲 3 天。今日新聞提到日本央行突然大幅升息，可留意後續影響。", f, heads) ?? "", /標題/);
  assert.equal(validateInsight("太短", f), "內容太短");
});

function insightKV(data: Record<string, unknown>) {
  const puts: Record<string, string> = {};
  const kv = {
    get: async (k: string) => (puts[k] ? JSON.parse(puts[k]) : (data[k] ?? null)),
    put: async (k: string, v: string) => { puts[k] = v; },
  } as unknown as KVNamespace;
  return { kv, puts, env: { NEWS: kv } as unknown as Env };
}

const OK_TEXT = "加權指數已連漲 2 天，上漲家數明顯多於下跌家數，個股表現分歧不大。";
const NOW_MS = at("14:50");

test("collectHeadlines：只拿當天的、舊摘要用顯示中的新聞、去重", async () => {
  const { kv } = insightKV({
    index: [
      { id: "new", generatedAt: "2026-11-09T04:00:00.000Z" },
      { id: "morning", generatedAt: "2026-11-08T23:00:00.000Z" },
      { id: "old", generatedAt: "2026-11-07T04:00:00.000Z" },
    ],
    "digest:new": { allHeadlines: ["甲", "乙"], regions: {} },
    "digest:morning": { regions: { tw: { events: [{ headline: "乙" }, { headline: "丙" }] }, world: { events: [] } } },
    "digest:old": { allHeadlines: ["舊"], regions: {} },
  });
  assert.deepEqual(await collectHeadlines(kv, "2026-11-09"), ["甲", "乙", "丙"]);
});

test("runInsightJob：把行情、連續天數和當天標題交給 AI；沒有收盤資料就不產生", async () => {
  const prev = { ...SNAP, date: "2026-11-06" };
  const { env, puts } = insightKV({
    "stocks:close:2026-11-09": SNAP,
    "stocks:close:2026-11-06": prev,
    "stocks:days": ["2026-11-09", "2026-11-06"],
    index: [{ id: "today", generatedAt: "2026-11-09T04:00:00.000Z" }],
    "digest:today": { allHeadlines: ["今天的候選標題"], regions: {} },
  });
  const sent: string[] = [];
  const model = { model: "m", text: async (_s: string, u: string) => (sent.push(u), OK_TEXT) };
  const r = await runInsightJob(env, { now: NOW_MS, model });
  assert.equal(r.stored, true);
  const saved = JSON.parse(puts["stocks:insight:2026-11-09"]);
  assert.equal(saved.text, OK_TEXT);
  assert.equal(saved.streaks.index, 2);
  assert.equal(saved.news, undefined);
  assert.deepEqual(saved.volumeStock.map((v: unknown[]) => v[0]), ["2330"]);
  assert.ok(sent[0].includes("今天的候選標題"));
  assert.ok(sent[0].includes("連漲 2 天"));
  // 連續紀錄存起來了，隔天接著算
  assert.equal(JSON.parse(puts["stocks:streaks"]).stocks["2464"], 2);

  const holiday = insightKV({});
  assert.equal((await runInsightJob(holiday.env, { now: NOW_MS, model })).stored, false);
  assert.deepEqual(holiday.puts, {});
});

test("runInsightJob：模型寫不好就只存數字，手動重做失敗時保留舊文字", async () => {
  const { env, puts } = insightKV({ "stocks:close:2026-11-09": SNAP, "stocks:days": ["2026-11-09"] });
  const original = console.error;
  console.error = () => {};
  try {
    let calls = 0;
    const bad = { model: "m", text: async () => (calls++, "加權指數上漲，主要因為美股大漲9999點，之後可能繼續走高的機會很大。") };
    await runInsightJob(env, { now: NOW_MS, model: bad });
    assert.equal(calls, 4);
    assert.equal(JSON.parse(puts["stocks:insight:2026-11-09"]).text, null);

    await runInsightJob(env, { now: NOW_MS, model: { model: "m", text: async () => "加權指數今日上漲，上漲家數明顯多於下跌家數，個股表現分歧不大。" } });
    const good = JSON.parse(puts["stocks:insight:2026-11-09"]).text;
    assert.ok(good);

    await runInsightJob(env, { force: true, now: NOW_MS, model: bad });
    assert.equal(JSON.parse(puts["stocks:insight:2026-11-09"]).text, good);
  } finally {
    console.error = original;
  }
});

test("insightCheckAt：今天的分析還沒進來時，14:52 再問一次", () => {
  assert.equal(insightCheckAt(at("14:35"), "2026-11-09", false), at("14:52"));
  assert.equal(insightCheckAt(at("14:35"), "2026-11-09", true), null);
  assert.equal(insightCheckAt(at("14:53"), "2026-11-09", false), null);
  assert.equal(insightCheckAt(at("14:35"), "2026-11-06", false), null);
});

test("insightSummaryParts：只有指數三個數字上色，跌的時候用跌色", () => {
  const breadth = { up: 993, down: 278, flat: 62, none: 3 };
  const up = lib.insightSummaryParts({ index: { value: 41661.7, change: 1960.06, pct: 4.94 }, breadth });
  assert.deepEqual(up.filter((p: { trend?: string }) => p.trend).map((p: { text: string; trend: string }) => [p.text, p.trend]), [["41,661.7", "up"], ["1,960.06", "up"], ["4.94%", "up"]]);
  assert.equal(up.map((p: { text: string }) => p.text).join(""), "加權指數收盤 41,661.7 點，上漲 1,960.06 點，漲幅 4.94%。上漲 993 家，下跌 278 家，平盤 62 家。");
  const down = lib.insightSummaryParts({ index: { value: 40000, change: -100.5, pct: -0.25 }, breadth });
  assert.deepEqual(down.filter((p: { trend?: string }) => p.trend).map((p: { text: string }) => p.text), ["40,000", "100.5", "0.25%"]);
  assert.ok(down.every((p: { trend?: string }) => !p.trend || p.trend === "down"));
  assert.match(down.map((p: { text: string }) => p.text).join(""), /下跌 100.5 點，跌幅 0.25%/);
});
