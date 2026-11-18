import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLive,
  insightCheckAt,
  liveBackoffMs,
  livePlan,
  mergeDaily,
  monthsBack,
  parseIndexHist,
  parseMisChart,
  wantsMisChart,
  parseViewMessage,
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
import { ensureDaily, fetchMis, fetchMisGradually, runCloseJob } from "../src/stocks/store.ts";
import { advanceStreaks, buildFacts, buildInsightPrompt, cleanInsightText, collectHeadlines, dayContext, moodOf, pickRecipe, runInsightJob, similarityProblem, styleProblem, usableHeadlines, validateInsight } from "../src/stocks/insight.ts";
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

/** MIS 每分鐘走勢的假資料（9:01、9:02 兩個點） */
function misChart(date: string) {
  const d = date.replace(/-/g, "");
  return {
    rtcode: "0000",
    infoArray: [{ d, y: "39,900.00", z: "40010.50" }],
    ohlcArray: [
      { c: "39950.00", t: String(taipeiMs(date, 541)), ts: "090100" },
      { c: "40010.50", t: String(taipeiMs(date, 542)) },
      { c: "-", t: String(taipeiMs(date, 543)) },
    ],
  };
}

function fakeTwse(misDate: string, opts: { failMis?: boolean } = {}) {
  const list = Array.from({ length: 600 }, (_, i) => ({ Code: String(1100 + i), Name: "股" + i }));
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("STOCK_DAY_ALL")) return Response.json(list);
    if (url.includes("getChartOhlcStatis")) return Response.json(misChart(misDate));
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

const noWait = { sleep: async () => {} };

test("runCloseJob：交易日存下今天的收盤價，第二次（14:40）不重抓", async () => {
  const { kv, m } = fakeKv();
  const now = at("14:30");
  const r = await runCloseJob({ NEWS: kv }, { now, gradual: noWait, fetch: fakeTwse("2026-11-09") });
  assert.equal(r.stored, true);
  const snap = JSON.parse(m.get("stocks:close:2026-11-09")!);
  assert.equal(snap.quotes.length, 600);
  assert.deepEqual(snap.quotes[0], ["1100", "股0", 10.5, 0.5, 5]);
  assert.equal(snap.index.value, 40000); // OpenAPI 日期對得上，用它的值
  assert.deepEqual(JSON.parse(m.get("stocks:days")!), ["2026-11-09"]);
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "ok");
  // 走勢圖：當天每分鐘走勢＋日線加上今天的收盤
  assert.deepEqual(JSON.parse(m.get("stocks:intraday")!).points, [[541, 39950], [542, 40010.5]]);
  assert.deepEqual(JSON.parse(m.get("stocks:indexDaily")!), [["2026-11-09", 40000]]);
  const again = await runCloseJob({ NEWS: kv }, { now: at("14:40"), retry: true, gradual: noWait, fetch: fakeTwse("2026-11-09", { failMis: true }) });
  assert.equal(again.stored, false);
});

test("runCloseJob：休市日標記 holiday，並補存最近交易日", async () => {
  const { kv, m } = fakeKv();
  await runCloseJob({ NEWS: kv }, { now: at("14:30"), gradual: noWait, fetch: fakeTwse("2026-11-06") });
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "holiday");
  assert.ok(m.has("stocks:close:2026-11-06"));
  assert.equal(phaseAt(at("15:00"), JSON.parse(m.get("stocks:status")!)).phase, "closed");
});

test("runCloseJob：14:30 失敗記成 retry，14:40 再失敗記成 failed", async () => {
  const { kv, m } = fakeKv();
  await assert.rejects(runCloseJob({ NEWS: kv }, { now: at("14:30"), gradual: noWait, fetch: fakeTwse("2026-11-09", { failMis: true }) }));
  assert.equal(JSON.parse(m.get("stocks:status")!).state, "retry");
  await assert.rejects(runCloseJob({ NEWS: kv }, { now: at("14:40"), retry: true, gradual: noWait, fetch: fakeTwse("2026-11-09", { failMis: true }) }));
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

const misOk = (code: string) => new Response(JSON.stringify({ rtcode: "0000", msgArray: [{ c: code, z: "100", y: "99", v: "1", d: "20261118" }] }));
const codeOf = (input: unknown) => /tse_(\w+)\.tw/.exec(decodeURIComponent(String(input)))![1];
const timeoutError = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

test("fetchMisGradually：一次只送兩批，組與組之間有間隔", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sleeps: number[] = [];
  const f = (async (input: unknown) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return misOk(codeOf(input));
  }) as typeof fetch;
  const batches = ["A", "B", "C", "D", "E"].map((c) => [`tse_${c}.tw`]);
  const rows = await fetchMisGradually(batches, f, { sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(rows.map((r) => r.code), ["A", "B", "C", "D", "E"]);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(sleeps, [500, 500]);
});

test("fetchMisGradually：逾時的批次等一下補抓，順序不變", async () => {
  const tries = new Map<string, number>();
  const f = (async (input: unknown) => {
    const c = codeOf(input);
    tries.set(c, (tries.get(c) ?? 0) + 1);
    if (c === "B" && tries.get(c)! < 3) throw timeoutError();
    return misOk(c);
  }) as typeof fetch;
  const sleeps: number[] = [];
  const rows = await fetchMisGradually([["tse_A.tw"], ["tse_B.tw"], ["tse_C.tw"]], f, { sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(rows.map((r) => r.code), ["A", "B", "C"]);
  assert.equal(tries.get("A"), 1);
  assert.equal(tries.get("B"), 3);
  assert.deepEqual(sleeps, [500, 3_000, 10_000]);
});

test("fetchMisGradually：補抓完還是失敗才丟錯", async () => {
  const f = (async (input: unknown) => {
    if (codeOf(input) === "B") throw timeoutError();
    return misOk(codeOf(input));
  }) as typeof fetch;
  await assert.rejects(fetchMisGradually([["tse_A.tw"], ["tse_B.tw"]], f, { sleep: async () => {} }), /1\/2 批補抓後仍失敗：The operation was aborted due to timeout/);
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

test("validateInsight：擋數字、因果用語、角色背景、不在標題裡的事件；角色的加碼心聲不擋", () => {
  const f = buildFacts(SNAP, { date: SNAP.date, index: 2, stocks: { "2330": 3 } });
  const heads = ["央行宣布利率維持不變", "美國加密貨幣價格大幅下跌"];
  const good = "大盤連漲 2 天了…漲…漲了漲了…哈哈哈哈！今日新聞提到央行宣布利率維持不變…管它的，我要加碼！";
  assert.equal(validateInsight(good, f, heads), null);
  assert.equal(validateInsight("怎麼會這樣啊啊啊…怎麼會跌這麼多…我要冷靜…要冷靜…怎麼可能冷靜啊啊啊啊！", f), null); // 冷靜不擋，慘叫不算語助詞
  assert.match(validateInsight("大盤連漲 99 天了…哈哈哈哈！我要 all in！", f) ?? "", /99/);
  assert.match(validateInsight(good + "這是美股帶動的結果。", f, heads) ?? "", /帶動/);
  assert.match(validateInsight("怎麼會這樣！大跌！不甘心！要抄底！明天一定會反彈…", f) ?? "", /慘叫或笑聲/);
  assert.match(validateInsight("怎麼會這樣啊啊啊！大跌！不甘心！要抄底！明天一定會反彈！", f) ?? "", /「…」/);
  assert.equal(validateInsight("啊啊啊啊…怎麼會這樣…又跌了…不甘心…一定要扳回來…", f), null); // 驚嘆號是軟性要求
  assert.match(styleProblem("啊啊啊啊…怎麼會這樣…又跌了…不甘心…一定要扳回來…", {}) ?? "", /驚嘆號/);
  assert.equal(validateInsight("啊啊啊啊...怎麼會這樣...又跌了！不甘心...一定要扳回來！", f), null); // 半形刪節號也算
  assert.match(validateInsight("啊啊啊啊…下跌家數比上漲家數多這麼多…不甘心！", f) ?? "", /家數/);
  assert.match(validateInsight("啊啊啊怎麼這麼跌啊！怎麼辦…明天一定會反彈！", f) ?? "", /照抄/);
  assert.match(validateInsight(`${f.gainers[0][1]}居然漲成這樣…哈哈哈哈！我也要加碼！明天一定還會漲！`, f) ?? "", /個股/);
  assert.match(validateInsight("漲了啦…我好想加碼喔！一定還會漲吧！哈哈哈不甘心呢！", f) ?? "", /語助詞/);
  assert.match(validateInsight(good + "媽媽要是看到就好了。", f, heads) ?? "", /媽媽/);
  if (f.index?.pct) assert.match(validateInsight(`大盤漲了 ${Math.abs(f.index.pct)}% 欸…哈哈哈哈！我好想加碼！`, f) ?? "", /指數/);
  assert.match(validateInsight("好".repeat(201), f) ?? "", /太長/);
  // 新聞標題裡的數字不算數（盤中報導的點數會被當成收盤漲幅）
  assert.match(validateInsight("啊啊啊啊！今天強漲近1400點...哈哈哈哈！我要加碼！", f, ["台股強漲近1400點"]) ?? "", /1400/);
  assert.match(validateInsight("啊啊啊…今日新聞提到日本央行突然大幅升息…怎麼辦！", f, heads) ?? "", /標題/);
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

const OK_TEXT = "漲…漲了漲了…哈哈哈哈！這樣下去我要加碼了，明天一定還會漲！";
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
  assert.equal(saved.text, cleanInsightText(OK_TEXT)); // 存的是整理過標點的文字
  assert.equal(saved.streaks.index, 2);
  assert.equal(saved.news, undefined);
  assert.deepEqual(saved.volumeStock.map((v: unknown[]) => v[0]), ["2330"]); // 排行照樣存（頁面方框要用）
  assert.ok(!sent[0].includes("台積電")); // 但不給模型個股名單
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
    assert.equal(calls, 5);
    assert.equal(JSON.parse(puts["stocks:insight:2026-11-09"]).text, null);

    await runInsightJob(env, { now: NOW_MS, model: { model: "m", text: async () => OK_TEXT } });
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

// ── 盤中輪流抓 ──

test("livePlan：第 1 批是指數＋正在看的，第 2 批輪流；輪完一圈回到開頭", () => {
  const universe = ["1101", "1102", "2330", "2454", "2603"];
  const a = livePlan(universe, ["2330", "2330", "2603"], 0, 2);
  assert.deepEqual(a.batches, [["tse_t00.tw", "tse_2330.tw"], ["tse_1101.tw", "tse_1102.tw"]]);
  assert.equal(a.nextCursor, 2);
  const b = livePlan(universe, [], a.nextCursor, 2);
  assert.deepEqual(b.batches[1], ["tse_2330.tw", "tse_2454.tw"]);
  const c = livePlan(universe, [], 4, 2);
  assert.deepEqual(c.batches[1], ["tse_2603.tw"]);
  assert.equal(c.nextCursor, 0);
});

test("livePlan：正在看的股票超過一批時截斷，總共永遠只有 2 個請求", () => {
  const universe = Array.from({ length: 300 }, (_, i) => String(1000 + i));
  const plan = livePlan(universe, universe, 135);
  assert.equal(plan.batches.length, 2);
  assert.equal(plan.batches[0].length, 135);
  assert.equal(plan.batches[0][0], "tse_t00.tw");
});

test("parseViewMessage：只收格式正確、清單裡有的代號，最多 60 檔", () => {
  const known = new Set(Array.from({ length: 100 }, (_, i) => String(1000 + i)));
  assert.deepEqual(parseViewMessage(JSON.stringify({ type: "view", codes: ["1000", "9999", 5, "1000", "1001"] }), known), ["1000", "1001"]);
  assert.equal(parseViewMessage(JSON.stringify({ type: "view", codes: [...known] }), known)?.length, 60);
  assert.equal(parseViewMessage("ping", known), null);
  assert.equal(parseViewMessage(JSON.stringify({ type: "other", codes: [] }), known), null);
  assert.equal(parseViewMessage("x".repeat(3000), known), null);
});

// ── 加權指數走勢圖 ──

test("parseMisChart：每分鐘的點換成台北當天第幾分鐘，昨收當基準；格式不對回傳 null", () => {
  const c = parseMisChart(misChart("2026-11-10"));
  assert.deepEqual(c, { date: "2026-11-10", prev: 39900, points: [[541, 39950], [542, 40010.5]] });
  assert.equal(parseMisChart({ rtcode: "0000" }), null);
  assert.equal(parseMisChart(null), null);
});

test("parseIndexHist：民國日期與千分位，只取收盤；stat 不是 OK 就是空的", () => {
  const rows = parseIndexHist({ stat: "OK", data: [["115/11/02", "45,034.53", "45,156.17", "44,399.10", "44,920.14"], ["壞掉的列"]] });
  assert.deepEqual(rows, [["2026-11-02", 44920.14]]);
  assert.deepEqual(parseIndexHist({ stat: "很抱歉，沒有符合條件的資料!" }), []);
});

test("mergeDaily／monthsBack：合併排序只留最後幾天；往前推月份會跨年", () => {
  assert.deepEqual(mergeDaily([["2026-11-02", 1], ["2026-11-03", 2]], [["2026-11-03", 3], ["2026-10-30", 0.5]], 2), [["2026-11-02", 1], ["2026-11-03", 3]]);
  assert.deepEqual(monthsBack("2026-02-10", 3), ["20251201", "20260101", "20260201"]);
});

test("wantsMisChart：平日 9:00 後、KV 裡還不是今天才向 MIS 抓", () => {
  assert.equal(wantsMisChart(at("08:59"), "2026-11-06"), false);
  assert.equal(wantsMisChart(at("09:00"), "2026-11-06"), true);
  assert.equal(wantsMisChart(at("14:35"), "2026-11-09"), false); // 收盤排程已經存好今天的
  assert.equal(wantsMisChart(at("10:00", "2026-11-08"), "2026-11-06"), false); // 週日
});

test("ensureDaily：資料太少就補抓最近 5 個月並存起來；夠多就不抓", async () => {
  const { kv, m } = fakeKv();
  const asked: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const ym = new URL(String(input)).searchParams.get("date")!;
    asked.push(ym);
    const roc = `${Number(ym.slice(0, 4)) - 1911}/${ym.slice(4, 6)}`;
    return Response.json({ stat: "OK", data: Array.from({ length: 20 }, (_, i) => [`${roc}/${String(i + 1).padStart(2, "0")}`, "1", "1", "1", String(40000 + i)]) });
  }) as typeof fetch;
  const pts = await ensureDaily(kv, at("15:00"), f);
  assert.deepEqual(asked, ["20260701", "20260801", "20260901", "20261001", "20261101"]);
  assert.equal(pts.length, 100);
  assert.equal(JSON.parse(m.get("stocks:indexDaily")!).length, 100);
  asked.length = 0;
  await ensureDaily(kv, at("15:00"), f);
  assert.equal(asked.length, 0);
});

test("stocks-lib：走勢圖的刻度、比例尺、最近的點、即時尾巴", () => {
  assert.deepEqual(lib.niceTicks(41930, 43136, 3), [42000, 42500, 43000]);
  assert.deepEqual(lib.niceTicks(5, 5), [5]);
  const sc = lib.chartScale([10, 20], 15, 0, 10, { left: 0, right: 100, top: 0, bottom: 100 });
  assert.equal(sc.x(5), 50);
  assert.ok(sc.y(20) > 0 && sc.y(10) < 100 && sc.y(20) < sc.y(10)); // 上下留邊，數字大的在上面
  assert.equal(lib.nearestIndex([0, 10, 20, 30], 14), 1);
  assert.equal(lib.nearestIndex([0, 10, 20, 30], 16), 2);
  assert.equal(lib.nearestIndex([0, 10, 20, 30], 99), 3);
  assert.deepEqual(lib.withLiveTail([[540, 1]], [541.5, 2]), [[540, 1], [541.5, 2]]);
  assert.deepEqual(lib.withLiveTail([[542, 1]], [541.5, 2]), [[542, 1]]);
  assert.equal(lib.fmtMinute(545.9), "9:05");
});

test("kurumiImage：依漲跌幅分五段，同一段依日期固定挑一張；沒有漲跌幅不放圖", () => {
  assert.equal(lib.kurumiImage("2026-11-10", -1.5), "/kurumi/1.webp");
  assert.equal(lib.kurumiImage("2026-11-11", -3), "/kurumi/4.webp");
  assert.equal(lib.kurumiImage("2026-11-10", -0.31), "/kurumi/2.webp");
  assert.equal(lib.kurumiImage("2026-11-10", 0.3), "/kurumi/8.webp");
  assert.equal(lib.kurumiImage("2026-11-10", -0.3), "/kurumi/8.webp");
  assert.equal(lib.kurumiImage("2026-11-10", 1.2), "/kurumi/7.webp");
  assert.equal(lib.kurumiImage("2026-11-09", 4.94), "/kurumi/6.webp");
  assert.equal(lib.kurumiImage("2026-11-10", null), null);
});

test("cleanInsightText：刪節號統一成半形「...」，驚嘆號、問號換成全形，重複的合併", () => {
  assert.equal(cleanInsightText("怎麼會這樣啊啊啊!!!要不要抄底… 會不會反彈??好想…"), "怎麼會這樣啊啊啊！要不要抄底...會不會反彈？好想...");
});

test("usableHeadlines：講台股大盤漲跌的標題（多半是盤中報導）不給模型", () => {
  assert.deepEqual(usableHeadlines(["台股強漲近1400點", "加權指數盤中翻黑", "央行宣布利率維持不變"]), ["央行宣布利率維持不變"]);
});

// ── 評論每天不一樣 ──

const buildInsightPromptForTest = (recipe: ReturnType<typeof pickRecipe>) => buildInsightPrompt(buildFacts(SNAP, null), [], { recipe });

test("moodOf／pickRecipe：同一天抽到的設定固定，會避開最近幾天用過的", () => {
  assert.deepEqual([-2.63, -1, 0, 1.35, 4.94, null].map((p) => moodOf(p)), ["bigDown", "down", "flat", "up", "bigUp", "flat"]);
  const a = pickRecipe("2026-11-12", -2.63);
  assert.deepEqual(pickRecipe("2026-11-12", -2.63), a);
  // 把同一組設定當成「最近用過」：三項都要換掉
  const b = pickRecipe("2026-11-12", -2.63, [a]);
  assert.ok(b.scene !== a.scene && b.feeling !== a.feeling && b.opening !== a.opening);
  // 漲的日子用過的處境不影響跌的日子（池子不同）
  assert.equal(pickRecipe("2026-11-12", -2.63, [{ ...a, mood: "bigUp" }]).scene, a.scene);
});

test("dayContext：星期幾、前一天、最近 5 天、近期新低、離高點多遠", () => {
  const daily: [string, number][] = [
    ["2026-11-04", 100], ["2026-11-05", 110], ["2026-11-06", 108], ["2026-11-09", 107], ["2026-11-10", 106], ["2026-11-11", 105], ["2026-11-12", 104], ["2026-11-13", 99],
  ];
  const c = dayContext("2026-11-13", daily);
  assert.ok(c[0].startsWith("今天是星期五，收盤後要等兩天"));
  assert.ok(c.includes("前一個交易日：跌 0.95%"));
  assert.ok(c.includes("最近幾個交易日依序是：小跌、小跌、小跌，然後今天暴跌"));
  assert.ok(c.includes("最近 5 個交易日合計：跌 8.33%"));
  assert.ok(c.includes("今天的收盤是最近 8 個交易日最低"));
  assert.ok(c.includes("比最近 8 個交易日的最高收盤低 10%"));
  assert.deepEqual(dayContext("2026-11-16", daily), ["今天是星期一，休市兩天後的第一個交易日"]); // 日線裡沒有這一天
});

test("similarityProblem：開頭、結尾一樣，或整段太像，都要重寫；真的不一樣就放行", () => {
  const prev = [{ date: "2026-11-12", pct: -2.63, text: "啊啊啊啊！怎麼會這樣...這樣的跌法...真的要讓我崩潰了！一定要抄底，不能就這樣認輸...一定要扳回來！哈哈哈哈！我一定會加碼，all in，明天一定會反彈！啊啊啊啊！" }];
  // 使用者回報的 11/16 那段：和 11/12 幾乎一樣
  const same = "啊啊啊啊！怎麼會這樣...這樣的跌法...真的要讓我崩潰了！哈哈哈哈！不對，不是哈哈哈哈！怎麼會這樣...我一定要抄底，明天一定會反彈！我要all in，不能放棄！";
  assert.match(similarityProblem(same, prev) ?? "", /開頭/);
  assert.match(similarityProblem("不是吧...我一定會加碼，all in，明天一定會反彈！啊啊啊啊！", prev) ?? "", /結尾/);
  assert.match(similarityProblem("騙人...這樣的跌法真的要讓我崩潰了！一定要抄底，不能就這樣認輸...一定要扳回來！手機好燙。", prev) ?? "", /太像|說過了/);
  const fresh = "欸...手機蓋在桌上三秒我又翻開了...還是綠的...昨天才說要抄底的是誰啊啊啊啊！這個月的晚餐錢都在裡面欸...我不看了，真的不看了！";
  assert.equal(similarityProblem(fresh, prev), null);
  assert.equal(similarityProblem(fresh, []), null);
  // 整段不像，但有一句整句照搬
  assert.match(similarityProblem("欸...手機好燙...不能就這樣認輸一定要扳回來...我去打工算了！", prev) ?? "", /說過了/);
});

test("styleProblem：說明式的句子、照抄設定的字句都要重寫", () => {
  const recipe = pickRecipe("2026-11-12", -2.63);
  assert.match(styleProblem("欸...現在我在想，如果當初少買一點就好了啊啊啊啊！", {}) ?? "", /說明式/);
  const prompt = buildInsightPromptForTest(recipe);
  const scene = /處境：(.+)/.exec(prompt)?.[1] ?? "";
  assert.ok(scene.length >= 9);
  assert.match(styleProblem(`欸...${scene}...啊啊啊啊！`, { recipe }) ?? "", /照抄設定/);
  assert.equal(styleProblem("欸...手機又被我翻開了...還是綠的啊啊啊啊！", { recipe }), null);
});

test("cleanInsightText：混進來的簡體字換成繁體", () => {
  assert.equal(cleanInsightText("该不会我真的是天才...现在还没涨够！"), "該不會我真的是天才...現在還沒漲夠！");
});

test("validateInsight：同一句話重複三次以上要重寫；行情背景裡的數字可以用", () => {
  const f = buildFacts(SNAP, { date: SNAP.date, index: 2, stocks: {} });
  assert.match(validateInsight("啊啊啊啊！不是吧...啊啊啊啊！手機好燙...啊啊啊啊！我不看了！", f) ?? "", /重複太多次/);
  const text = "欸...最近 5 天已經漲了 8.33%...哈哈哈哈！我果然是天才！";
  assert.match(validateInsight(text, f) ?? "", /不在提供的資料裡/);
  assert.equal(validateInsight(text, f, [], ["最近 5 個交易日合計：漲 8.33%"]), null);
});

test("runInsightJob：把行情背景、今天的設定、前幾天說過的話交給模型；太像就重寫，設定存起來", async () => {
  const old = "啊啊啊啊！怎麼會這樣...這樣的跌法...真的要讓我崩潰了！一定要抄底...一定要扳回來！哈哈哈哈！";
  const { env, puts } = insightKV({
    "stocks:close:2026-11-09": SNAP,
    "stocks:close:2026-11-06": { ...SNAP, date: "2026-11-06" },
    "stocks:days": ["2026-11-09", "2026-11-06"],
    "stocks:insight:2026-11-06": { date: "2026-11-06", index: { value: 1, change: -1, pct: -2 }, text: old, persona: "kurumi", recipe: pickRecipe("2026-11-09", SNAP.index?.pct) },
    "stocks:indexDaily": [["2026-11-05", 40000], ["2026-11-06", 39701.64]],
  });
  const original = console.error;
  console.error = () => {};
  try {
    const sent: string[] = [];
    const temps: (number | undefined)[] = [];
    const fresh = "欸...手機蓋在桌上三秒我又翻開了...漲了漲了...哈哈哈哈！我果然是天才，今天晚餐要吃燒肉！";
    const model = { model: "m", text: async (_s: string, u: string, _n: number, t?: number) => (sent.push(u), temps.push(t), sent.length === 1 ? old : fresh) };
    await runInsightJob(env, { now: NOW_MS, model });
    const saved = JSON.parse(puts["stocks:insight:2026-11-09"]);
    assert.equal(saved.text, fresh);
    assert.equal(sent.length, 2); // 第一次和 11/6 一樣，被退回
    assert.match(sent[1], /開頭和 11\/6 說的一樣/);
    assert.match(sent[1], /每一點都要改掉/);
    assert.ok(sent[0].includes("今天是星期一") && sent[0].includes("前一個交易日：跌 0.75%"));
    assert.ok(sent[0].includes("今天的設定") && sent[0].includes("處境：") && sent[0].includes("心情："));
    assert.ok(sent[0].includes("11/6（那天大跌）：" + old));
    assert.ok(sent[0].includes("大盤今天：暴漲") && !sent[0].includes("4.94")); // 今天的漲跌只給形容，不給數字
    assert.ok((temps[0] ?? 0) > 0.5); // 評論用比較高的隨機度
    // 今天的設定避開了 11/6 用過的那一組
    assert.notDeepEqual(saved.recipe, pickRecipe("2026-11-09", SNAP.index?.pct));
  } finally {
    console.error = original;
  }
});

test("runInsightJob：date 重做指定的那一天，不動最新的連續紀錄", async () => {
  const { env, puts } = insightKV({
    "stocks:close:2026-11-09": SNAP,
    "stocks:close:2026-11-06": { ...SNAP, date: "2026-11-06" },
    "stocks:days": ["2026-11-09", "2026-11-06"],
  });
  const r = await runInsightJob(env, { date: "2026-11-06", model: { model: "m", text: async () => OK_TEXT } });
  assert.equal(r.date, "2026-11-06");
  assert.ok(puts["stocks:insight:2026-11-06"]);
  assert.equal(puts["stocks:streaks"], undefined);
});
