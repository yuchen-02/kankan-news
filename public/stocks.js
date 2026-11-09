// 台股頁面：收盤價（KV）＋盤中推送（WebSocket，只在這個分頁正被看著時連線）
import {
  fmtDay,
  fmtVolume,
  insightSummaryParts,
  fmtPrice,
  fmtChange,
  fmtPct,
  trendOf,
  rowsFromClose,
  applyLive,
  filterRows,
  sortRows,
  nextPctSort,
  resolveColors,
  colorsLabel,
  visibleRange,
  statusText,
  wantsLive,
  nextCheckDelay,
} from "./stocks-lib.js";

const COLORS_KEY = "jiegui:stockColors";
const INSIGHT_KEY = "jiegui:stockInsight"; // 收盤分析收合（"0"）或展開
const INSIGHT_NOTE = "評論由 AI 依當日行情與新聞標題整理，內容可能有誤，非投資建議；提到的新聞不代表與漲跌有因果關係。";
const ROW_H = 44; // 每一列的高度（px），要和 style.css 的 --stk-row 一樣
const MENU_DAYS_OPEN = 10; // 日曆選單預設列出最近幾個交易日，更早的收在「更早」裡

/**
 * @param {{ $: (s: string) => any, el: Function, store: { get(k: string): string|null, set(k: string, v: string): void }, toast: (t: string) => void }} ctx
 */
export function createStocks(ctx) {
  const { $, el, store, toast } = ctx;

  const s = {
    active: false, // 台股頁面正在顯示
    loaded: false,
    phase: "closed",
    nextCheckAt: null,
    today: null,
    liveEnabled: false,
    latest: null, // 最近一天的收盤資料
    viewing: null, // 正在看的往期收盤資料（null＝最新）
    insight: null, // 最近一天的收盤分析
    viewingInsight: null, // 正在看的往期的收盤分析
    days: null,
    rows: new Map(),
    live: null, // { status, date, time, stale }
    index: null,
    sort: "code",
    query: "",
    ws: null,
    wsRetry: 0,
    wsTimer: 0,
    checkTimer: 0,
    checkFails: 0, // 連續幾次問不到伺服器
    view: [], // 篩選＋排序後的列
  };

  // ── 漲跌顏色 ──
  const root = document.documentElement;
  const applyColors = (mode) => {
    root.dataset.stockColors = mode;
    const btn = $("#stk-colors");
    const label = "目前" + colorsLabel(mode) + "，按一下切換";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };
  applyColors(resolveColors(store.get(COLORS_KEY)));
  $("#stk-colors").addEventListener("click", () => {
    const mode = resolveColors(root.dataset.stockColors) === "tw" ? "us" : "tw";
    store.set(COLORS_KEY, mode);
    applyColors(mode);
    toast("已切換為" + colorsLabel(mode));
  });

  // ── 搜尋、排序 ──
  $("#stk-search").addEventListener("input", (e) => {
    s.query = e.target.value;
    rebuild();
  });
  $("#stk-sort-code").addEventListener("click", () => setSort("code"));
  $("#stk-sort-pct").addEventListener("click", () => setSort(nextPctSort(s.sort)));
  function setSort(sort) {
    s.sort = sort;
    $("#stk-sort-code").closest("[role=columnheader]").setAttribute("aria-sort", sort === "code" ? "ascending" : "none");
    $("#stk-sort-pct").closest("[role=columnheader]").setAttribute("aria-sort", sort === "pct-desc" ? "descending" : sort === "pct-asc" ? "ascending" : "none");
    $("#stk-sort-pct").dataset.dir = sort === "pct-desc" ? "desc" : sort === "pct-asc" ? "asc" : "";
    rebuild();
  }

  // ── 虛擬捲動：1,000 多列只畫看得到的那幾十列 ──
  const body = $("#stk-body");
  let raf = 0;
  const schedulePaint = () => {
    if (raf || !s.active) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  };
  addEventListener("scroll", schedulePaint, { passive: true });
  addEventListener("resize", schedulePaint);

  function rowEl(r) {
    const t = trendOf(r.change);
    const row = el("div", { class: "stk-row t-" + t, role: "row" });
    row.appendChild(el("span", { class: "c-code", role: "cell", text: r.code }));
    row.appendChild(el("span", { class: "c-name", role: "cell", text: r.name }));
    row.appendChild(el("span", { class: "c-price", role: "cell", text: fmtPrice(r.price) }));
    row.appendChild(el("span", { class: "c-chg", role: "cell", text: fmtChange(r.change, r.price) }));
    row.appendChild(el("span", { class: "c-pct", role: "cell", text: fmtPct(r.pct) }));
    return row;
  }

  function paint() {
    const n = s.view.length;
    body.style.height = n * ROW_H + "px";
    const { start, end } = visibleRange(body.getBoundingClientRect().top, innerHeight, ROW_H, n);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = rowEl(s.view[i]);
      row.style.transform = "translateY(" + i * ROW_H + "px)";
      row.setAttribute("aria-rowindex", String(i + 2));
      frag.appendChild(row);
    }
    body.replaceChildren(frag);
    const empty = $("#stk-empty");
    if (!s.rows.size) {
      empty.textContent = s.loaded ? "還沒有收盤資料，第一次抓取完成後這裡就會有內容。" : "正在讀取台股資料…";
      empty.hidden = false;
    } else if (!n) {
      empty.textContent = "找不到符合「" + s.query.trim() + "」的股票。";
      empty.hidden = false;
    } else empty.hidden = true;
    $("#stk-table").setAttribute("aria-rowcount", String(n + 1));
  }

  /** 篩選／排序有變（或資料整批換掉）時重算清單 */
  function rebuild() {
    s.view = sortRows(filterRows([...s.rows.values()], s.query), s.sort);
    paint();
  }

  /** 盤中只有價格變了：依代號排序時順序不變，只要重畫看得到的列；依漲跌幅排序時要重排 */
  function refreshPrices() {
    if (s.sort === "code") paint();
    else rebuild();
  }

  // ── 收盤分析 ──
  const insightBox = $("#stk-insight");
  if (store.get(INSIGHT_KEY) === "0") insightBox.open = false;
  insightBox.addEventListener("toggle", () => {
    store.set(INSIGHT_KEY, insightBox.open ? "1" : "0");
    schedulePaint(); // 高度變了，股票表格要重算看得到哪幾列
  });

  function rankBlock(title, rows) {
    const list = el("ol", { class: "ins-rank" });
    for (const r of rows) {
      const li = el("li", { class: "t-" + trendOf(r.pct) });
      li.appendChild(el("span", { class: "c-name", text: r.code + " " + r.name }));
      li.appendChild(el("span", { class: "c-pct", text: r.value }));
      list.appendChild(li);
    }
    return el("div", { class: "ins-block" }, [el("h4", { text: title }), list]);
  }

  function renderInsight() {
    const ins = s.viewing ? s.viewingInsight : s.insight;
    insightBox.hidden = !ins;
    if (ins) {
      $("#stk-insight-date").textContent = fmtDay(ins.date);
      const body = $("#stk-insight-body");
      body.textContent = "";
      const summary = el("p", { class: "ins-summary" });
      for (const p of insightSummaryParts(ins)) {
        summary.appendChild(p.trend ? el("span", { class: "ins-num ins-" + p.trend, text: p.text }) : document.createTextNode(p.text));
      }
      body.appendChild(summary);
      if (ins.text) body.appendChild(el("p", { class: "ins-text", text: ins.text }));
      const asPct = (q) => ({ code: q[0], name: q[1], pct: q[3], value: fmtPct(q[3]) });
      const asVolume = (q) => ({ code: q[0], name: q[1], pct: q[3], value: fmtVolume(q[2]) });
      const ranks = el("div", { class: "ins-ranks" });
      for (const [title, rows] of [
        ["漲幅前 5 名", (ins.gainers || []).map(asPct)],
        ["跌幅前 5 名", (ins.losers || []).map(asPct)],
        ["ETF 成交量前 5 名", (ins.volumeEtf || []).map(asVolume)],
        ["個股成交量前 5 名", (ins.volumeStock || []).map(asVolume)],
      ]) {
        if (rows.length) ranks.appendChild(rankBlock(title, rows));
      }
      body.appendChild(ranks);
      body.appendChild(el("p", { class: "ins-note", text: INSIGHT_NOTE }));
    }
    schedulePaint();
  }

  // ── 上方：期別、狀態、加權指數 ──
  function renderHead() {
    const snap = s.viewing || s.latest;
    const issue = $("#stk-issue");
    issue.textContent = "";
    issue.appendChild(el("span", { class: "issue-name", text: "台股" }));
    issue.appendChild(el("span", { class: "issue-when", text: statusText({ phase: s.phase, viewing: s.viewing, snap, live: s.live }) }));
    if (s.viewing) issue.appendChild(el("span", { class: "issue-old", text: "往期" }));
    issue.classList.toggle("busy", !s.viewing && s.phase === "fetching");

    const idx = s.viewing ? s.viewing.index : s.index || (s.latest && s.latest.index);
    const box = $("#stk-index");
    box.textContent = "";
    box.appendChild(el("span", { class: "ix-name", text: "加權指數" }));
    const t = trendOf(idx ? idx.change : null);
    box.className = "stk-index t-" + t;
    box.appendChild(el("span", { class: "ix-value", text: idx ? fmtPrice(idx.value) : "—" }));
    box.appendChild(el("span", { class: "ix-chg", text: idx ? fmtChange(idx.change) : "—" }));
    box.appendChild(el("span", { class: "ix-pct", text: idx ? fmtPct(idx.pct) : "" }));
  }

  // ── 盤中推送 ──
  const shouldLive = () => s.active && !s.viewing && s.liveEnabled && wantsLive(s.phase) && document.visibilityState === "visible";

  function connect() {
    clearTimeout(s.wsTimer);
    if (s.ws || !shouldLive()) return;
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/stocks/live");
    s.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      s.wsRetry = 0;
      if (m.type === "status") {
        s.live = Object.assign({}, s.live, { status: m.status, stale: m.status === "stale" });
        renderHead();
        return;
      }
      if (m.status === "holiday") {
        // 今天休市：顯示收盤資料就好，不用一直連著
        s.live = { status: "holiday" };
        disconnect();
        resetToClose();
        return;
      }
      s.live = { status: m.status, date: m.date, time: m.time, stale: false };
      if (m.index) s.index = m.index;
      applyLive(s.rows, m.quotes);
      if (m.type === "full") rebuild();
      else refreshPrices();
      renderHead();
    };
    ws.onclose = () => {
      if (s.ws !== ws) return;
      s.ws = null;
      if (!shouldLive()) return;
      // 不是我們自己關的：稍後重連（3 秒起，最長 30 秒）
      s.wsRetry += 1;
      s.live = Object.assign({}, s.live, { stale: true });
      renderHead();
      s.wsTimer = setTimeout(connect, Math.min(3000 * 2 ** (s.wsRetry - 1), 30000));
    };
  }

  function disconnect() {
    clearTimeout(s.wsTimer);
    const ws = s.ws;
    s.ws = null;
    if (ws) try { ws.close(1000, "bye"); } catch (e) { /* 已經關了 */ }
  }

  /** 把畫面換回收盤資料（最新或往期） */
  function resetToClose() {
    const snap = s.viewing || s.latest;
    s.rows = rowsFromClose(snap ? snap.quotes : []);
    s.index = null;
    rebuild();
    renderHead();
    renderInsight();
  }

  // ── 狀態：問伺服器現在是盤中、收盤、還是在抓收盤價 ──
  const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });

  async function check() {
    clearTimeout(s.checkTimer);
    try {
      const j = await getJson("/api/stocks");
      const prevPhase = s.phase;
      const prevDate = s.latest && s.latest.date;
      s.phase = j.phase;
      s.nextCheckAt = j.nextCheckAt;
      s.today = j.today;
      s.liveEnabled = !!j.live;
      s.latest = j.latest;
      s.insight = j.insight || null;
      const first = !s.loaded || s.checkFails > 0; // 失敗後第一次成功，也要把「沒載進來」的訊息換掉
      s.checkFails = 0;
      s.loaded = true;
      // 收盤價進來了（或第一次載入、或從盤中狀態離開）：畫面換成收盤資料
      const latestChanged = (s.latest && s.latest.date) !== prevDate;
      if (!s.viewing && (first || latestChanged || (wantsLive(prevPhase) && !wantsLive(s.phase)) || (!s.ws && !wantsLive(s.phase)))) {
        resetToClose();
      } else {
        renderHead();
        renderInsight();
      }
      if (shouldLive()) connect();
      else if (!wantsLive(s.phase)) disconnect();
      if (latestChanged) s.days = null; // 日曆清單要重抓
    } catch (e) {
      s.checkFails += 1;
      if (!s.loaded) {
        s.loaded = true;
        $("#stk-empty").textContent = "台股資料沒載進來，晚點再重新整理看看。";
        $("#stk-empty").hidden = false;
      }
    }
    // 到了下一個狀態可能改變的時間（開盤、收盤、14:30…）再問一次
    const delay = nextCheckDelay(s.nextCheckAt, Date.now(), s.checkFails);
    if (s.active && delay !== null && document.visibilityState === "visible") {
      s.checkTimer = setTimeout(check, delay);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!s.active) return;
    if (document.visibilityState === "visible") {
      // 切回來：狀態可能變了（例如離開時是盤中，回來已經收盤），先問一次再決定要不要連線
      check();
    } else {
      disconnect();
      clearTimeout(s.checkTimer);
    }
  });

  // ── 日曆：往期收盤資料 ──
  const menu = $("#stk-time-menu");
  const menuBtn = $("#stk-time-btn");

  function dayButton(date) {
    const current = s.viewing ? s.viewing.date === date : !!s.latest && s.latest.date === date;
    const b = el("button", { type: "button", class: "slot", text: fmtDay(date) });
    b.setAttribute("aria-pressed", String(current));
    b.addEventListener("click", () => { closeMenu(); selectDay(date); });
    return b;
  }

  function monthBlocks(days) {
    const out = [];
    let cur = null;
    for (const d of days) {
      const key = d.slice(0, 7);
      if (!cur || cur.key !== key) {
        cur = { key, block: el("div", { class: "day" }), slots: el("div", { class: "slots" }) };
        cur.block.appendChild(el("h4", { text: Number(d.slice(0, 4)) + " 年 " + Number(d.slice(5, 7)) + " 月" }));
        cur.block.appendChild(cur.slots);
        out.push(cur);
      }
      cur.slots.appendChild(dayButton(d));
    }
    return out.map((x) => x.block);
  }

  async function renderMenu() {
    menu.textContent = "";
    if (s.viewing) {
      const back = el("button", { type: "button", class: "menu-latest", text: "回到最新" });
      back.addEventListener("click", () => { closeMenu(); selectDay(null); });
      menu.appendChild(back);
    }
    if (!s.days) {
      menu.appendChild(el("p", { class: "menu-empty", text: "讀取中…" }));
      try { s.days = (await getJson("/api/stocks/days")).days || []; } catch (e) { s.days = null; }
      if (menu.hidden) return;
      return renderMenu();
    }
    if (!s.days.length) {
      menu.appendChild(el("p", { class: "menu-empty", text: "還沒有任何一天的收盤資料" }));
      return;
    }
    for (const b of monthBlocks(s.days.slice(0, MENU_DAYS_OPEN))) menu.appendChild(b);
    const older = s.days.slice(MENU_DAYS_OPEN);
    if (older.length) {
      const det = el("details", { class: "older" }, [el("summary", { text: "更早的 " + older.length + " 天" })]);
      for (const b of monthBlocks(older)) det.appendChild(b);
      menu.appendChild(det);
    }
  }

  function openMenu() {
    menu.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    renderMenu();
  }
  function closeMenu() {
    menu.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !$("#stk-time-pick").contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) { closeMenu(); menuBtn.focus(); }
  });

  async function selectDay(date) {
    // 選最新的那一天＝回到最新（盤中時會重新連線）
    if (!date || (s.latest && date === s.latest.date)) {
      s.viewing = null;
      resetToClose();
      check();
      return;
    }
    try {
      const j = await getJson("/api/stocks/day?date=" + encodeURIComponent(date));
      s.viewing = j.snapshot;
      s.viewingInsight = j.insight || null;
      disconnect();
      resetToClose();
      scrollTo({ top: 0 });
    } catch (e) {
      toast("這一天的資料已經被清掉囉");
    }
  }

  return {
    show() {
      s.active = true;
      check();
      schedulePaint();
    },
    hide() {
      s.active = false;
      disconnect();
      closeMenu();
      clearTimeout(s.checkTimer);
    },
  };
}
