// 加權指數走勢圖：當日（每分鐘）／1 個月／3 個月（每日收盤）。手刻 SVG，不用外部套件
import { fmtDay, fmtPrice, fmtChange, fmtPct, trendOf, fmtMinute, niceTicks, chartScale, nearestIndex, withLiveTail } from "./stocks-lib.js";

const RANGE_KEY = "jiegui:stockChartRange";
const RANGES = ["day", "1m", "3m"];
const RANGE_DAYS = { "1m": 22, "3m": 66 }; // 大約幾個交易日
const OPEN_MIN = 9 * 60;
const CLOSE_MIN = 13 * 60 + 30;
const REFRESH_MS = 60_000; // 盤中每分鐘重抓一次當日走勢（伺服器全站共用，最多每分鐘向證交所抓一次）
const NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") n.textContent = v;
    else n.setAttribute(k, String(v));
  }
  for (const k of kids) n.appendChild(k);
  return n;
}

const pathOf = (pts) => pts.map(([x, y], i) => (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1)).join("");

/**
 * @param {{ $: (s: string) => any, el: Function, store: { get(k: string): string|null, set(k: string, v: string): void }, getJson: (url: string) => Promise<any> }} ctx
 */
export function createIndexChart(ctx) {
  const { $, el, store, getJson } = ctx;
  const box = $("#stk-chart-box");
  const read = $("#stk-chart-read");
  const tabs = [...$("#stk-chart").querySelectorAll("[data-range]")];

  const c = {
    range: RANGES.includes(store.get(RANGE_KEY)) ? store.get(RANGE_KEY) : "day",
    intraday: null, // { date, prev, points: [[分鐘, 指數]] }
    daily: null, // [[日期, 收盤]]
    intradayFor: undefined, // 已經為哪一天（最新收盤日）讀過，換日才重讀
    dailyFor: undefined,
    live: null, // 即時指數 { date, minute, value, prev }
    active: false,
    liveOn: false, // 盤中：每分鐘重抓、最後一點跟著即時指數
    viewing: null, // 正在看往期的哪一天（只能看日線）
    latestDate: null,
    timer: 0,
    hover: null, // 手指／滑鼠指著第幾個點
    cur: null, // 目前畫出來的資料與座標
  };

  /** 實際顯示的範圍：看往期時沒有當日走勢，改看 3 個月 */
  const effRange = () => (c.viewing && c.range === "day" ? "3m" : c.range);

  async function loadIntraday() {
    try {
      c.intraday = (await getJson("/api/stocks/intraday")).chart || c.intraday;
    } catch (e) {
      /* 下一分鐘再試；畫面保留舊的 */
    }
    draw();
  }

  async function loadDaily() {
    try {
      c.daily = (await getJson("/api/stocks/daily")).points || [];
    } catch (e) {
      c.dailyFor = undefined; // 下次切換時再試
    }
    draw();
  }

  /** 依目前狀態決定要不要讀資料、要不要每分鐘重抓 */
  function ensure() {
    const r = effRange();
    if (!c.active) return;
    if (r === "day" && c.intradayFor !== c.latestDate) {
      c.intradayFor = c.latestDate;
      loadIntraday();
    }
    if (r !== "day" && c.dailyFor !== c.latestDate) {
      c.dailyFor = c.latestDate;
      loadDaily();
    }
    const want = c.active && c.liveOn && r === "day";
    if (want && !c.timer) {
      c.timer = setInterval(loadIntraday, REFRESH_MS);
      loadIntraday(); // 剛開盤、或切回這個分頁：先抓一次
    } else if (!want && c.timer) {
      clearInterval(c.timer);
      c.timer = 0;
    }
  }

  /** 要畫的資料：{ kind, xs, ys, base, baseLabel, x0, x1, when(i), ref(i), mark } */
  function series() {
    if (effRange() === "day") {
      const d = c.intraday;
      const live = c.live && !c.viewing ? c.live : null;
      if (!d && !live) return null;
      let date = d ? d.date : live.date;
      let pts = d ? d.points : [];
      let prev = d ? d.prev : null;
      if (live && live.date > date) {
        // 開盤了但還沒抓到今天的走勢：先只畫即時指數
        date = live.date;
        pts = [];
        prev = null;
      }
      if (live && live.date === date && live.minute <= CLOSE_MIN) pts = withLiveTail(pts, [live.minute, live.value]);
      if (prev === null && live && live.date === date) prev = live.prev;
      const xs = pts.map((p) => p[0]);
      return {
        kind: "day",
        date,
        xs,
        ys: pts.map((p) => p[1]),
        base: prev,
        baseLabel: "昨收",
        x0: OPEN_MIN,
        x1: Math.max(CLOSE_MIN, ...xs), // 收盤指數在 13:33 左右才出來
        when: (i) => fmtMinute(xs[i]),
        ref: () => prev,
        mark: -1,
      };
    }
    if (!c.daily) return null;
    const all = c.daily.slice();
    const last = all[all.length - 1];
    if (c.live && !c.viewing && (!last || c.live.date > last[0])) all.push([c.live.date, c.live.value]);
    let end = all.length;
    let mark = -1;
    if (c.viewing) {
      const at = all.findIndex((p) => p[0] === c.viewing);
      if (at >= 0 && at < end - RANGE_DAYS[effRange()]) end = at + 1; // 太早的日子：範圍改成到那一天為止
      mark = at;
    }
    const start = Math.max(0, end - RANGE_DAYS[effRange()]);
    const win = all.slice(start, end);
    if (!win.length) return null;
    const base = start > 0 ? all[start - 1][1] : win[0][1];
    return {
      kind: "daily",
      xs: win.map((_, i) => i),
      ys: win.map((p) => p[1]),
      dates: win.map((p) => p[0]),
      base,
      baseLabel: "期初",
      x0: 0,
      x1: Math.max(1, win.length - 1),
      when: (i) => fmtDay(win[i][0]),
      ref: (i) => (i > 0 ? win[i - 1][1] : base),
      mark: mark >= start ? mark - start : -1,
    };
  }

  function showReadout(i) {
    read.textContent = "";
    const s = c.cur && c.cur.s;
    if (!s || !s.ys.length) {
      read.className = "chart-read";
      return;
    }
    const v = s.ys[i];
    const ref = s.ref(i);
    const chg = ref ? Math.round((v - ref) * 100) / 100 : null;
    read.className = "chart-read t-" + trendOf(chg);
    read.appendChild(el("span", { class: "cr-when", text: s.when(i) }));
    read.appendChild(el("span", { class: "cr-val", text: fmtPrice(v) }));
    if (chg !== null) read.appendChild(el("span", { class: "cr-chg", text: fmtChange(chg) + " " + fmtPct((chg / ref) * 100) }));
  }

  function placeHover() {
    const cur = c.cur;
    if (!cur) return;
    // 沒指著任何點時：看往期顯示那一天，否則顯示最新一點
    const i = c.hover !== null ? c.hover : cur.s.mark >= 0 ? cur.s.mark : cur.px.length - 1;
    if (c.hover === null || i < 0) cur.guide.setAttribute("visibility", "hidden");
    else {
      cur.guide.setAttribute("x1", cur.px[i]);
      cur.guide.setAttribute("x2", cur.px[i]);
      cur.guide.setAttribute("visibility", "visible");
    }
    if (i >= 0) {
      cur.dot.setAttribute("cx", cur.px[i]);
      cur.dot.setAttribute("cy", cur.py[i]);
      cur.dot.setAttribute("class", "chart-dot t-" + trendOf(cur.s.base === null ? 0 : cur.s.ys[i] - cur.s.base));
    }
    showReadout(i);
  }

  function draw() {
    tabs.forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.range === effRange()));
      b.disabled = b.dataset.range === "day" && !!c.viewing;
    });
    const s = series();
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!s || !w || !h) {
      c.cur = null;
      box.replaceChildren(el("p", { class: "chart-empty", text: s ? "" : effRange() === "day" ? (c.intradayFor === undefined ? "" : "走勢資料讀取中…") : "日線資料讀取中…" }));
      showReadout(0);
      return;
    }
    const B = { left: 2, right: w - 58, top: 10, bottom: h - 22 };
    const sc = chartScale(s.ys, s.base, s.x0, s.x1, B);
    const px = s.xs.map(sc.x);
    const py = s.ys.map(sc.y);
    const baseY = s.base === null ? B.bottom : Math.min(B.bottom, Math.max(B.top, sc.y(s.base)));

    const root = svg("svg", { class: "chart-svg", width: w, height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
    root.appendChild(
      svg("defs", {}, [
        svg("clipPath", { id: "ixc-up" }, [svg("rect", { x: 0, y: 0, width: w, height: baseY })]),
        svg("clipPath", { id: "ixc-dn" }, [svg("rect", { x: 0, y: baseY, width: w, height: Math.max(0, h - baseY) })]),
      ]),
    );
    // y 軸：格線＋右邊的數字
    for (const v of niceTicks(sc.lo, sc.hi, 3)) {
      const y = sc.y(v);
      if (y < B.top - 1 || y > B.bottom + 1) continue;
      root.appendChild(svg("line", { class: "chart-grid", x1: B.left, x2: B.right, y1: y, y2: y }));
      root.appendChild(svg("text", { class: "chart-tick", x: B.right + 6, y: y + 4, text: fmtPrice(v) }));
    }
    // x 軸
    const xt = (x, text, anchor) => root.appendChild(svg("text", { class: "chart-tick", x, y: h - 6, "text-anchor": anchor, text }));
    if (s.kind === "day") {
      // 手機上 13:00 和 13:30 太近會疊在一起，太擠就省略 13:00
      const lastHr = sc.x(CLOSE_MIN) - sc.x(13 * 60) < 46 ? 12 : 13;
      for (let hr = 9; hr <= lastHr; hr++) xt(sc.x(hr * 60), hr + ":00", hr === 9 ? "start" : "middle");
      xt(sc.x(CLOSE_MIN), "13:30", "end");
      if (s.x1 > CLOSE_MIN) root.appendChild(svg("line", { class: "chart-grid", x1: sc.x(CLOSE_MIN), x2: sc.x(CLOSE_MIN), y1: B.top, y2: B.bottom }));
    } else {
      const n = s.xs.length;
      const picks = [...new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1])];
      const md = (d) => Number(d.slice(5, 7)) + "/" + Number(d.slice(8, 10));
      picks.forEach((i, k) => xt(px[i], md(s.dates[i]), k === 0 ? "start" : k === picks.length - 1 ? "end" : "middle"));
    }
    // 走勢：同一條線，高於基準的部分用漲的顏色、低於的用跌的顏色
    if (px.length) {
      const pts = px.map((x, i) => [x, py[i]]);
      const line = pathOf(pts);
      const area = line + "L" + px[px.length - 1].toFixed(1) + " " + baseY.toFixed(1) + "L" + px[0].toFixed(1) + " " + baseY.toFixed(1) + "Z";
      for (const [cls, clip] of [["ln-up", "ixc-up"], ["ln-down", "ixc-dn"]]) {
        root.appendChild(svg("g", { class: cls, "clip-path": `url(#${clip})` }, [svg("path", { class: "chart-area", d: area }), svg("path", { class: "chart-line", d: line })]));
      }
    }
    // 基準虛線（當日＝昨收，日線＝期初）
    if (s.base !== null) {
      root.appendChild(svg("line", { class: "chart-base", x1: B.left, x2: B.right, y1: baseY, y2: baseY }));
      const above = baseY - B.top > 16;
      root.appendChild(svg("text", { class: "chart-base-label", x: B.left + 4, y: above ? baseY - 5 : baseY + 13, text: s.baseLabel + " " + fmtPrice(s.base) }));
    }
    // 看往期時標出那一天
    if (s.mark >= 0) root.appendChild(svg("circle", { class: "chart-mark", cx: px[s.mark], cy: py[s.mark], r: 5 }));
    const guide = svg("line", { class: "chart-guide", y1: B.top, y2: B.bottom, visibility: "hidden" });
    const dot = svg("circle", { class: "chart-dot", r: 3.5 });
    root.appendChild(guide);
    if (px.length) root.appendChild(dot);
    box.replaceChildren(root);

    c.cur = { s, px, py, guide, dot };
    if (c.hover !== null && c.hover >= px.length) c.hover = null;
    placeHover();
    box.setAttribute("aria-label", ariaText(s));
  }

  function ariaText(s) {
    if (!s.ys.length) return "加權指數走勢圖，目前沒有資料";
    const i = s.ys.length - 1;
    const range = s.kind === "day" ? "當日走勢" : "近 " + s.ys.length + " 個交易日收盤";
    return "加權指數" + range + "，" + s.when(0) + " " + fmtPrice(s.ys[0]) + "，" + s.when(i) + " " + fmtPrice(s.ys[i]);
  }

  // ── 滑鼠／手指移上去顯示那一點的數值 ──
  function onPoint(e) {
    if (!c.cur || !c.cur.px.length) return;
    const x = e.clientX - box.getBoundingClientRect().left;
    c.hover = nearestIndex(c.cur.px, x);
    placeHover();
  }
  box.addEventListener("pointermove", onPoint);
  box.addEventListener("pointerdown", onPoint);
  box.addEventListener("pointerleave", () => {
    c.hover = null;
    placeHover();
  });

  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      c.range = b.dataset.range;
      store.set(RANGE_KEY, c.range);
      c.hover = null;
      ensure();
      draw();
    }),
  );

  if (typeof ResizeObserver === "function") new ResizeObserver(() => c.active && draw()).observe(box);

  return {
    /** 台股頁的狀態變了（renderHead 時呼叫） */
    sync(o) {
      const was = c.viewing;
      c.active = o.active;
      c.liveOn = o.liveOn;
      c.viewing = o.viewing;
      c.latestDate = o.latestDate;
      if (was !== c.viewing) c.hover = null;
      ensure();
      draw();
    },
    /** 即時指數（盤中每 5 秒）：當日走勢最後一點跟著動 */
    setLive(date, time, index) {
      const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(time || "");
      c.live =
        date && m && index && index.value
          ? { date, minute: +m[1] * 60 + +m[2] + +m[3] / 60, value: index.value, prev: index.change === null || index.change === undefined ? null : index.value - index.change }
          : null;
      draw();
    },
    stop() {
      c.active = false;
      clearInterval(c.timer);
      c.timer = 0;
    },
  };
}
