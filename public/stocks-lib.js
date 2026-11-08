// 台股頁面用的純函式（不碰 DOM，方便測試）

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** "2026-11-06" → "11/6（五）" */
export function fmtDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!m) return "";
  const wk = WEEK[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return Number(m[2]) + "/" + Number(m[3]) + "（" + wk + "）";
}

/** 價格：1000 以下固定兩位小數（92.50），1000 以上加千分位、最多兩位（2,135）；沒有就是 "—" */
export function fmtPrice(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: v < 1000 ? 2 : 0, maximumFractionDigits: 2 });
}

/** 漲跌：+12.50 / -105 / 0；小數位數跟著價格走（價格 1000 以下固定兩位），沒有就是 "—" */
export function fmtChange(v, price) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const two = Number.isFinite(price) && price < 1000 && v !== 0;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: two ? 2 : 0, maximumFractionDigits: 2 });
  return v > 0 ? "+" + s : v < 0 ? "-" + s : "0";
}

/** 漲跌幅：+1.23% / -0.50% / 0.00% */
export function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(2) + "%";
  return v > 0 ? "+" + s : v < 0 ? "-" + s : s;
}

/** 漲／跌／平（決定顏色用） */
export function trendOf(change) {
  if (change === null || change === undefined || !Number.isFinite(change) || change === 0) return "flat";
  return change > 0 ? "up" : "down";
}

/** 收盤資料 [代號, 名稱, 現價, 漲跌, 漲跌幅] → 列 */
export function rowsFromClose(quotes) {
  const map = new Map();
  for (const q of quotes || []) map.set(q[0], { code: q[0], name: q[1], price: q[2], change: q[3], pct: q[4] });
  return map;
}

/**
 * 盤中資料 [代號, 現價, 漲跌, 漲跌幅] 套到現有的列上（名稱沿用收盤資料的）。
 * full：完整資料，清單裡沒出現的股票保留原本的；delta：只更新有變的那幾檔。兩種寫法一樣，差別只在送來的筆數。
 */
export function applyLive(rows, quotes) {
  for (const q of quotes || []) {
    const r = rows.get(q[0]);
    if (r) {
      r.price = q[1];
      r.change = q[2];
      r.pct = q[3];
    } else {
      rows.set(q[0], { code: q[0], name: q[0], price: q[1], change: q[2], pct: q[3] });
    }
  }
  return rows;
}

/** 搜尋：代號或名稱包含關鍵字（不分大小寫、忽略前後空白） */
export function filterRows(list, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((r) => r.code.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q));
}

/**
 * 排序：code＝依代號（預設）、pct-desc＝漲跌幅由高到低、pct-asc＝由低到高。
 * 沒有漲跌幅（還沒成交）的一律排在最後；漲跌幅一樣時依代號。
 */
export function sortRows(list, sort) {
  const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  if (sort !== "pct-desc" && sort !== "pct-asc") return [...list].sort(byCode);
  const dir = sort === "pct-desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const an = a.pct === null || a.pct === undefined;
    const bn = b.pct === null || b.pct === undefined;
    if (an !== bn) return an ? 1 : -1;
    if (!an && a.pct !== b.pct) return (a.pct - b.pct) * dir;
    return byCode(a, b);
  });
}

/** 點「漲跌幅」：第一次由高到低，再點一次反過來 */
export function nextPctSort(current) {
  return current === "pct-desc" ? "pct-asc" : "pct-desc";
}

/** 漲跌顏色：tw＝紅漲綠跌（台股習慣，預設）、us＝綠漲紅跌 */
export function resolveColors(stored) {
  return stored === "us" ? "us" : "tw";
}
export function colorsLabel(mode) {
  return mode === "us" ? "綠漲紅跌" : "紅漲綠跌";
}

/** 虛擬捲動：目前看得到哪幾列（前後多畫 overscan 列，捲動時不會露白） */
export function visibleRange(listTop, viewportH, rowH, count, overscan = 8) {
  const first = Math.floor(Math.max(0, -listTop) / rowH);
  const last = Math.ceil(Math.max(0, viewportH - listTop) / rowH);
  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) };
}

/**
 * 頁面上方那一行狀態文字。
 * phase：伺服器判斷的狀態；live：盤中推送的最新狀態（沒連上時是 null）；snap：目前顯示的收盤資料
 */
export function statusText(o) {
  const { phase, viewing, snap, live } = o;
  const closeLabel = snap ? fmtDay(snap.date) + " 收盤價" : "還沒有收盤資料";
  if (viewing) return closeLabel;
  if (live && live.status === "holiday") return "今日休市 · 顯示 " + closeLabel;
  const stale = live && live.stale ? "（連線不穩，資料可能延遲）" : "";
  switch (phase) {
    case "pre":
      return "尚未開盤 · 顯示 " + closeLabel;
    case "live":
      if (!live || !live.time) return "盤中 · 連線中…";
      return "盤中 · " + live.time + " 更新" + stale;
    case "after":
      return "已收盤 · 最後成交價" + stale;
    case "fetching":
      return "正在抓取收盤價，請稍後";
    case "failed":
      return "收盤價暫時無法取得 · 顯示最後成交價";
    default:
      return closeLabel;
  }
}

/** 這個狀態要不要連盤中推送（盤中、收盤後到收盤價抓到之前，都顯示最後成交價） */
export function wantsLive(phase) {
  return phase === "live" || phase === "after" || phase === "fetching" || phase === "failed";
}
