import {
  TAIPEI,
  TABS,
  resolveTimeZone,
  formatClock,
  fmtDateTime,
  resolveTheme,
  nextTheme,
  groupByDay,
  timeOfDay,
  slotLabelOf,
  editionName,
  DIGEST_RETENTION_DAYS,
  weatherUrl,
  parseWeather,
  cardCountries,
  dayPart,
  tempLevel,
  humidityLevel,
  rainLevel,
  segmentsFor,
  reverseGeocodeUrl,
  placeNameFromGeocode,
  toneOf,
  flagUrl,
} from "./lib.js";
import { createStocks } from "./stocks.js";
import { initFeedback } from "./feedback.js";

/** 意見表單：送到和 anime 專案共用的回饋服務；project 會出現在信的標題與資料庫裡 */
const FEEDBACK_URL = "https://feedback.looksomenews.workers.dev";
const FEEDBACK_PROJECT = "news-digest";

const KEY = { visit: "jiegui:lastVisit", theme: "jiegui:theme", tab: "jiegui:tab", geo: "jiegui:geo" };
const REGION_LABEL = { tw: "台灣", world: "世界" };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 無痕模式等情況，忽略 */ } },
};
const $ = (s) => document.querySelector(s);

function el(tag, props, children) {
  const n = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      if (k === "text") n.textContent = props[k];
      else if (k === "class") n.className = props[k];
      else n.setAttribute(k, props[k]);
    }
  }
  for (const c of children || []) if (c) n.appendChild(c);
  return n;
}
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : "#");

const state = { index: [], current: null, lastVisit: null, tab: "tw" };
const isUnseen = (iso) => state.lastVisit !== null && Date.parse(iso) > state.lastVisit;

// ── 亮／暗色 ────────────────────────────────────────

// 動態風格：預設 calm（低調）。網址加 ?motion=lively 可預覽活潑版；實際數值都在 style.css 的 --m-* 變數
function initMotion() {
  const m = new URLSearchParams(location.search).get("motion");
  if (m === "calm" || m === "lively") document.documentElement.dataset.motion = m;
}

function initTheme() {
  const root = document.documentElement;
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const btn = $("#theme-toggle");
  const meta = document.querySelector('meta[name="theme-color"]');

  const apply = (t) => {
    root.dataset.theme = t;
    if (meta) meta.setAttribute("content", t === "dark" ? "#121416" : "#e9eaea");
    btn.setAttribute("aria-label", t === "dark" ? "切換成亮色背景" : "切換成暗色背景");
  };

  apply(resolveTheme(store.get(KEY.theme), mq.matches));

  // 沒有手動選過時，使用者本機的設定改變（例如晚上自動切暗色）也跟著變
  if (mq.addEventListener) {
    mq.addEventListener("change", (e) => {
      const stored = store.get(KEY.theme);
      if (stored !== "light" && stored !== "dark") apply(resolveTheme(null, e.matches));
    });
  }

  btn.addEventListener("click", () => {
    const t = nextTheme(root.dataset.theme);
    store.set(KEY.theme, t);
    // 只在手動切換的瞬間開啟顏色過渡，避免載入頁面時整頁閃一下
    root.classList.add("theme-fading");
    clearTimeout(initTheme.timer);
    initTheme.timer = setTimeout(() => root.classList.remove("theme-fading"), 450);
    apply(t);
  });
}

// ── 現在時間 ────────────────────────────────────────

// ── 時鐘：七段顯示器＋時段圖示 ──────────────────────

const SVGNS = "http://www.w3.org/2000/svg";

// 七段的形狀（viewBox 60×100）。橫條與直條都是兩端尖的六角形，段與段之間留一點縫
const SEG_T = 9;
function hBar(x1, x2, y) {
  const h = SEG_T / 2;
  return [[x1, y], [x1 + h, y - h], [x2 - h, y - h], [x2, y], [x2 - h, y + h], [x1 + h, y + h]];
}
function vBar(x, y1, y2) {
  const h = SEG_T / 2;
  return [[x, y1], [x + h, y1 + h], [x + h, y2 - h], [x, y2], [x - h, y2 - h], [x - h, y1 + h]];
}
const SEG_SHAPES = {
  a: hBar(8, 52, 4.5),
  b: vBar(55.5, 8, 47),
  c: vBar(55.5, 53, 92),
  d: hBar(8, 52, 95.5),
  e: vBar(4.5, 53, 92),
  f: vBar(4.5, 8, 47),
  g: hBar(8, 52, 50),
};

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  return n;
}

function segDigit(ch) {
  const on = segmentsFor(ch) || "";
  const svg = svgEl("svg", { class: "seg-digit", viewBox: "0 0 60 100", "aria-hidden": "true" });
  for (const k of Object.keys(SEG_SHAPES)) {
    svg.appendChild(svgEl("polygon", { class: on.includes(k) ? "seg on" : "seg", points: SEG_SHAPES[k].map((p) => p.join(",")).join(" ") }));
  }
  return svg;
}

function segColon() {
  const svg = svgEl("svg", { class: "seg-colon", viewBox: "0 0 20 100", "aria-hidden": "true" });
  svg.appendChild(svgEl("rect", { class: "seg on", x: "6", y: "29", width: "9", height: "9" }));
  svg.appendChild(svgEl("rect", { class: "seg on", x: "6", y: "62", width: "9", height: "9" }));
  return svg;
}

/** 把 "16:42" 畫成七段顯示器；沒亮的段會用很淡的顏色留著，像真的液晶螢幕 */
function renderSegClock(box, text) {
  box.textContent = "";
  for (const ch of text) box.appendChild(ch === ":" ? segColon() : segDigit(ch));
  box.setAttribute("aria-label", text);
}

const ICON_ATTR = 'viewBox="0 0 24 24" aria-hidden="true"';
const DAY_ICONS = {
  night: `<svg ${ICON_ATTR}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a8 8 0 1 0 9.5 9.5z"/><path d="M17 3v3M15.5 4.5h3"/></svg>`,
  morning: `<svg ${ICON_ATTR}><path d="M5 17a7 7 0 0 1 14 0"/><path d="M2.5 17h19M12 4.5v3M4.8 9.3l1.9 1.9M19.2 9.3l-1.9 1.9"/><path d="M9.5 21l2.5-2.5 2.5 2.5"/></svg>`,
  noon: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>`,
  afternoon: `<svg ${ICON_ATTR}><circle cx="9" cy="9" r="3.2"/><path d="M9 2.5v1.6M2.5 9h1.6M4.4 4.4l1.1 1.1M13.6 4.4l-1.1 1.1"/><path d="M8 20h9.5a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.4 1.6A2.8 2.8 0 0 0 8 20z"/></svg>`,
  dusk: `<svg ${ICON_ATTR}><path d="M5 17a7 7 0 0 1 14 0"/><path d="M2.5 17h19M12 4.5v3M4.8 9.3l1.9 1.9M19.2 9.3l-1.9 1.9"/><path d="M9.5 19.5l2.5 2.5 2.5-2.5"/></svg>`,
  evening: `<svg ${ICON_ATTR}><path d="M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/></svg>`,
};

function initClock() {
  const { tz, fallback } = resolveTimeZone();
  $("#clock-note").hidden = !fallback;
  let last = "";
  const tick = () => {
    const { dateText, timeText } = formatClock(new Date(), tz);
    if (timeText + dateText === last) return;
    last = timeText + dateText;
    renderSegClock($("#clock-time"), timeText);
    const part = dayPart(parseInt(timeText.slice(0, 2), 10));
    const icon = $("#clock-icon");
    if (icon.dataset.part !== part.key) {
      icon.dataset.part = part.key;
      icon.innerHTML = DAY_ICONS[part.key];
      icon.setAttribute("aria-label", part.label);
      icon.title = part.label;
    }
    $("#clock-date").textContent = dateText;
  };
  tick();
  setInterval(tick, 1000);
}

// ── 天氣 ────────────────────────────────────────────

const weather = { loc: TAIPEI, error: "" };

const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6"/></svg>';

const WI = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const THERMO = 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z';
const DROP = 'M12 3.5s6 6.3 6 10.5a6 6 0 0 1-12 0c0-4.2 6-10.5 6-10.5z';
const RAIN_CLOUD = 'M7.5 14h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6 1.4A2.9 2.9 0 0 0 7.5 14z';
const WEATHER_ICONS = {
  // 溫度：溫度計，水銀柱高度代表冷熱
  temp: {
    cold: WI(`<path d="${THERMO}"/><path d="M12 17.5v-2.5"/><path d="M18 5l-2 1.2M18 9l-2-1.2"/>`),
    cool: WI(`<path d="${THERMO}"/><path d="M12 17.5v-4.5"/>`),
    mild: WI(`<path d="${THERMO}"/><path d="M12 17.5v-7"/>`),
    warm: WI(`<path d="${THERMO}"/><path d="M12 17.5v-9"/><path d="M17 8h2.5M17 11h2.5"/>`),
    hot: WI(`<path d="${THERMO}"/><path d="M12 17.5v-11"/><path d="M17 6l2-1M17 9.5h2.5M17 13l2 1"/>`),
    scorching: WI(`<path d="${THERMO}"/><path d="M12 17.5v-11"/><path d="M17 5l2.5-1.2M17 8.5h3M17 12l2.5 1.2M17 15.5l2 1.5"/>`),
  },
  // 濕度：水滴，裡面的波浪越多越潮濕
  humidity: {
    dry: WI(`<path d="${DROP}" stroke-dasharray="2.2 2.4"/>`),
    mild: WI(`<path d="${DROP}"/>`),
    humid: WI(`<path d="${DROP}"/><path d="M8.6 14.6c1.1-.9 2.2-.9 3.4 0s2.3.9 3.4 0"/>`),
    veryhumid: WI(`<path d="${DROP}"/><path d="M8.6 12.8c1.1-.9 2.2-.9 3.4 0s2.3.9 3.4 0M8.6 16.2c1.1-.9 2.2-.9 3.4 0s2.3.9 3.4 0"/>`),
  },
  // 降雨：烏雲底下的雨滴，雨滴越多代表下雨機率越高
  rain: {
    low: WI(`<path d="${RAIN_CLOUD}"/><path d="M12 17.2l-.8 2.2"/>`),
    mid: WI(`<path d="${RAIN_CLOUD}"/><path d="M9.6 17.2l-.8 2.2M14.6 17.2l-.8 2.2"/>`),
    high: WI(`<path d="${RAIN_CLOUD}"/><path d="M8.2 17.2l-.8 2.2M12.2 17.2l-.8 2.2M16.2 17.2l-.8 2.2"/>`),
    veryhigh: WI(`<path d="${RAIN_CLOUD}"/><path d="M7.6 16.8l-1 3M11.2 16.8l-1 3M14.8 16.8l-1 3M18.4 16.8l-1 3"/>`),
  },
};

function weatherRow(kind, name, valueText, level) {
  const row = el("div", { class: "w-row", title: level.label || "" });
  const ic = el("span", { class: "w-ic w-ic-" + kind });
  ic.innerHTML = WEATHER_ICONS[kind][level.key] || "";
  row.appendChild(ic);
  row.appendChild(el("span", { class: "w-k", text: name }));
  row.appendChild(el("span", { class: "w-v", text: valueText }));
  row.appendChild(el("span", { class: "w-n", text: level.label }));
  return row;
}

function renderWeather(w) {
  const box = $("#weather");
  box.textContent = "";

  // 第 1 行：地區名稱＋定位按鈕
  const head = el("div", { class: "w-head" });
  head.appendChild(el("span", { class: "place", text: weather.error ? "天氣" : weather.loc.name }));
  const isDefault = weather.loc === TAIPEI;
  const label = isDefault ? "使用我的位置" : "改回台北";
  const btn = el("button", { type: "button", class: "geo-btn" + (isDefault ? "" : " on"), title: label });
  btn.setAttribute("aria-label", label);
  btn.innerHTML = PIN_SVG;
  btn.addEventListener("click", isDefault ? useMyLocation : useTaipei);
  head.appendChild(btn);
  box.appendChild(head);

  // 第 2–4 行：溫度、濕度、降雨（由上到下）
  if (weather.error) {
    box.appendChild(el("div", { class: "w-msg", text: weather.error }));
  } else if (w) {
    box.appendChild(weatherRow("temp", "溫度", w.temp + "°C", tempLevel(w.temp)));
    box.appendChild(weatherRow("humidity", "濕度", w.humidity + "%", humidityLevel(w.humidity)));
    box.appendChild(weatherRow("rain", "降雨", w.rain === null ? "—" : w.rain + "%", rainLevel(w.rain)));
  } else {
    box.appendChild(el("div", { class: "w-msg", text: "天氣暫時查不到" }));
  }
}

async function loadWeather() {
  try {
    const res = await fetch(weatherUrl(weather.loc.lat, weather.loc.lon), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(String(res.status));
    const w = parseWeather(await res.json());
    renderWeather(w);
  } catch (e) {
    renderWeather(null);
  }
}

function useTaipei() {
  weather.loc = TAIPEI;
  weather.error = "";
  store.set(KEY.geo, "0");
  loadWeather();
}

function locationFailed() {
  weather.loc = TAIPEI;
  weather.error = "抓不到你的位置";
  store.set(KEY.geo, "0");
  renderWeather(null);
}

/** 座標 → 地區名稱（BigDataCloud 的免註冊用戶端 API）。查不到就維持「目前位置」，不影響天氣 */
async function resolvePlaceName(loc) {
  try {
    const res = await fetch(reverseGeocodeUrl(loc.lat, loc.lon), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const name = placeNameFromGeocode(await res.json());
    if (name && weather.loc === loc) {
      loc.name = name;
      const place = document.querySelector("#weather .place");
      if (place) place.textContent = name;
    }
  } catch (e) { /* 維持「目前位置」 */ }
}

function useMyLocation() {
  if (!navigator.geolocation) return locationFailed();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const loc = { name: "目前位置", lat: pos.coords.latitude, lon: pos.coords.longitude };
      weather.loc = loc;
      weather.error = "";
      store.set(KEY.geo, "1");
      loadWeather();
      resolvePlaceName(loc); // 查到地區名稱後，把「目前位置」換成實際的縣市／區
    },
    locationFailed,
    { timeout: 10000, maximumAge: 600000 },
  );
}

async function initWeather() {
  // 以前授權過定位才會自動使用，避免一打開頁面就跳出授權詢問
  if (store.get(KEY.geo) === "1" && navigator.permissions && navigator.geolocation) {
    try {
      const p = await navigator.permissions.query({ name: "geolocation" });
      if (p.state === "granted") {
        useMyLocation();
        setInterval(loadWeather, 30 * 60 * 1000);
        return;
      }
    } catch (e) { /* 查不到權限狀態就用台北 */ }
  }
  loadWeather();
  setInterval(loadWeather, 30 * 60 * 1000);
}

// ── 台灣／世界 分頁 ─────────────────────────────────

function setTab(tab, opts) {
  const o = opts || {};
  state.tab = tab;
  for (const t of TABS) {
    const selected = t === tab;
    const btn = $("#tab-" + t);
    btn.setAttribute("aria-selected", String(selected));
    btn.tabIndex = selected ? 0 : -1;
    $("#panel-" + t).hidden = !selected;
  }
  if (o.focus) $("#tab-" + tab).focus();
}

function initTabs() {
  setTab("tw"); // 每次進來都先顯示台灣；不記住上次看的分頁
  for (const t of TABS) $("#tab-" + t).addEventListener("click", () => setTab(t));

  $("#tablist").addEventListener("keydown", (e) => {
    const i = TABS.indexOf(state.tab);
    let next = null;
    if (e.key === "ArrowRight") next = TABS[(i + 1) % TABS.length];
    else if (e.key === "ArrowLeft") next = TABS[(i - 1 + TABS.length) % TABS.length];
    else if (e.key === "Home") next = TABS[0];
    else if (e.key === "End") next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      setTab(next, { focus: true });
    }
  });

}

// ── 摘要內容 ────────────────────────────────────────

// ── 時間選單（日曆按鈕）────────────────────────────

const MENU_DAYS_OPEN = 7; // 選單裡預設展開最近幾天，更早的收在「更早」裡

function isLatest() {
  return !state.index.length || !state.current || state.current.id === state.index[0].id;
}

/** 時間格上的字：早報／午報／晚報。同一天有兩份落在同一期（例如手動觸發留下的）就多寫幾點幾分區分 */
function slotText(d, siblings) {
  const label = editionName(d.generatedAt);
  const dup = siblings.filter((x) => editionName(x.generatedAt) === label).length > 1;
  return dup ? label + " " + timeOfDay(d.generatedAt) : label;
}

function slotButton(d, siblings) {
  const unseen = isUnseen(d.generatedAt);
  const current = !!state.current && state.current.id === d.id;
  const b = el("button", { type: "button", class: "slot" + (unseen ? " unseen" : ""), text: slotText(d, siblings), title: timeOfDay(d.generatedAt) });
  b.setAttribute("aria-pressed", String(current));
  b.setAttribute("aria-label", slotText(d, siblings) + " " + timeOfDay(d.generatedAt) + (unseen ? "，還沒看過" : ""));
  b.addEventListener("click", () => { closeMenu(); select(d.id); });
  return b;
}

function dayBlock(g) {
  const day = el("div", { class: "day" });
  const title = g.label === g.dateText ? g.label : g.label + "　" + g.dateText;
  day.appendChild(el("h4", { text: title }));
  const slots = el("div", { class: "slots" });
  // 同一天裡早報、午報、晚報由左到右（groupByDay 給的是新到舊，這裡反過來）
  for (const d of [...g.items].reverse()) slots.appendChild(slotButton(d, g.items));
  day.appendChild(slots);
  return day;
}

function renderMenu() {
  const menu = $("#time-menu");
  menu.textContent = "";

  if (!isLatest()) {
    const back = el("button", { type: "button", class: "menu-latest", text: "回到最新" });
    back.addEventListener("click", () => { closeMenu(); select(state.index[0].id); });
    menu.appendChild(back);
  }

  // 摘要在資料庫只保留 DIGEST_RETENTION_DAYS 天；清單裡超過的就不列，避免點了讀不到
  const alive = state.index.filter((d) => Date.now() - Date.parse(d.generatedAt) < DIGEST_RETENTION_DAYS * 86400_000);
  const groups = groupByDay(alive, Date.now());
  if (!groups.length) {
    menu.appendChild(el("p", { class: "menu-empty", text: "還沒有任何一期" }));
  }
  for (const g of groups.slice(0, MENU_DAYS_OPEN)) menu.appendChild(dayBlock(g));
  const older = groups.slice(MENU_DAYS_OPEN);
  if (older.length) {
    const det = el("details", { class: "older" }, [el("summary", { text: "更早的 " + older.length + " 天" })]);
    for (const g of older) det.appendChild(dayBlock(g));
    menu.appendChild(det);
  }

  // 按鈕上的黃點：有還沒看過的摘要（現在看的是哪一期，由上方的期別列顯示）
  $("#time-dot").hidden = !state.index.some((d) => isUnseen(d.generatedAt));
}

function openMenu() {
  renderMenu();
  $("#time-menu").hidden = false;
  $("#time-btn").setAttribute("aria-expanded", "true");
}

function closeMenu() {
  $("#time-menu").hidden = true;
  $("#time-btn").setAttribute("aria-expanded", "false");
}

function initMenu() {
  const btn = $("#time-btn");
  btn.addEventListener("click", () => ($("#time-menu").hidden ? openMenu() : closeMenu()));
  document.addEventListener("click", (e) => {
    if (!$("#time-menu").hidden && !$("#time-pick").contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#time-menu").hidden) { closeMenu(); btn.focus(); }
  });
}

const MAX_FLAGS = 3;

function renderHeadline(text, region, url, summary) {
  // 台灣分頁裡不標記「台灣」（整頁都是台灣，標了只是雜訊）；世界分頁會標
  // 標題找不到任何國家時，才用摘要補一面國旗（不上底色）
  const { parts, codes } = cardCountries(text, summary, region === "tw" ? ["tw"] : []);
  const h = el("h3");
  const link = el("a", { class: "card-link", href: safeHref(url), target: "_blank", rel: "noopener noreferrer" });
  if (codes.length) {
    const shown = codes.slice(0, MAX_FLAGS);
    const flags = el("span", { class: "flags n" + shown.length, "aria-hidden": "true" });
    for (const code of shown) {
      const img = el("img", { src: flagUrl(code), alt: "", loading: "lazy", decoding: "async", width: "40", height: "27" });
      img.addEventListener("error", () => {
        img.remove();
        if (!flags.querySelector("img")) flags.remove(); // 國旗圖載入失敗就整個不顯示
      });
      flags.appendChild(img);
    }
    link.appendChild(flags);
  }
  const t = el("span", { class: "ht" });
  for (const p of parts) {
    if (p.code) t.appendChild(el("span", { class: "cn tone-" + toneOf(p.code), text: p.text }));
    else t.appendChild(document.createTextNode(p.text));
  }
  link.appendChild(t);
  h.appendChild(link);
  return h;
}

/** 依目前還在的圖片張數調整卡片版面（有圖／一張／兩張）；圖片載入失敗被拿掉後也會再呼叫 */
function syncThumbs(art) {
  const n = art.querySelectorAll("img.thumb").length;
  art.classList.toggle("has-thumb", n > 0);
  art.classList.toggle("thumbs-1", n === 1 && art.classList.contains("lead"));
  art.classList.toggle("thumbs-2", n === 2);
  const box = art.querySelector(".thumbs");
  if (box && !n) box.remove();
}

function renderEvent(e, region, i) {
  const art = el("article", { class: "event " + (i === 0 ? "lead" : "compact") });
  const body = el("div", { class: "body" });
  // 圖：頭條卡片最多兩張並排（有兩張不同的圖就都放，免得把一張小圖拉得又寬又糊）；
  // 其餘卡片放在內容區左上角的固定大小格子裡，圖依原比例縮進格子、不裁切；沒有圖（或圖載入失敗）就顯示佔位圖，
  // 所以每張緊湊卡片的版面都一樣，標題與摘要的位置才會對齊。
  // 直接引用媒體的圖；不送 Referer（避免被防盜連）
  const urls = [];
  const wanted = i === 0 && Array.isArray(e.imageUrls) && e.imageUrls.length > 1 ? e.imageUrls : [e.imageUrl];
  for (const u of wanted) if (u && /^https:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
  const lead = i === 0;
  const box = lead && urls.length ? el("div", { class: "thumbs" }) : null;
  const slot = lead ? null : el("div", { class: "thumb-slot" });
  for (const u of urls.slice(0, 2)) {
    const img = el("img", { class: "thumb", src: u, alt: "", loading: lead ? "eager" : "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => {
      img.remove();
      if (slot) slot.classList.add("empty");
      else syncThumbs(art);
    });
    (box || slot).appendChild(img);
    if (slot) break; // 緊湊卡片只放第一張
  }
  if (slot) {
    if (!urls.length) slot.classList.add("empty");
    body.appendChild(slot);
  }
  if (box) art.appendChild(box); // 頭條的圖在卡片最上面（內容區之前）
  // 上半：類型字幕條（左）＋編號（右）＋標題；舊的摘要沒有類型欄位就只有編號
  const head = el("div", { class: "head" });
  const meta = el("div", { class: "meta" });
  const cats = el("div", { class: "cats", "aria-label": "類型" });
  if (Array.isArray(e.categories)) {
    for (const c of e.categories.slice(0, 3)) cats.appendChild(el("span", { class: "cat", text: String(c) }));
  }
  meta.appendChild(cats);
  meta.appendChild(el("span", { class: "no", "aria-hidden": "true", text: String(i + 1).padStart(2, "0") }));
  head.appendChild(meta);
  // 整張卡片可以點：標題連結（第一個來源）用 ::after 蓋滿整張卡片；下方各來源的連結在它上面，照樣可以單獨點
  head.appendChild(renderHeadline(e.headline, region, e.sources[0] ? e.sources[0].url : "#", e.summary));
  // 下半：摘要＋來源
  const tail = el("div", { class: "tail" });
  tail.appendChild(el("p", { class: "summary", text: e.summary }));
  if (e.disputed) {
    tail.appendChild(el("p", { class: "disputed" }, [el("b", { text: "各來源說法不同：" }), document.createTextNode(e.disputed)]));
  }
  const srcs = el("div", { class: "srcs" });
  srcs.appendChild(el("span", { class: "src-label", text: "來源" }));
  for (const s of e.sources) {
    srcs.appendChild(el("a", { href: safeHref(s.url), target: "_blank", rel: "noopener noreferrer", title: s.title, text: s.name }));
  }
  tail.appendChild(srcs);
  body.appendChild(head);
  body.appendChild(tail);
  art.appendChild(body);
  syncThumbs(art);
  return art;
}

function renderPanel(region, r) {
  const panel = $("#panel-" + region);
  panel.textContent = "";
  if (r.error) panel.appendChild(el("p", { class: "err", text: "這一頁這次沒整理成功。" }));
  else if (r.articleCount === 0) panel.appendChild(el("p", { class: "empty", text: "這個時段各家媒體都沒有新文章。" }));
  else if (r.events.length === 0) panel.appendChild(el("p", { class: "empty", text: "這個時段沒有特別值得整理的大事。" }));
  // 第一則是頭條（大圖大標題），其餘排成兩欄的緊湊卡片
  const list = el("div", { class: "events" });
  r.events.forEach((e, i) => {
    const card = renderEvent(e, region, i);
    card.style.setProperty("--i", String(Math.min(i, 8))); // 進場延遲的順序，最多算到第 9 張，避免後面的等太久
    list.appendChild(card);
  });
  panel.appendChild(list);
}

/** 頁面上方的期別列：「午報」＋日期與整理的時間；看的是舊的一期時多一個「往期」 */
function renderIssue(d) {
  const box = $("#issue");
  box.textContent = "";
  const g = groupByDay([d], Date.now())[0];
  box.appendChild(el("span", { class: "issue-name", text: editionName(d.generatedAt) }));
  box.appendChild(el("span", { class: "issue-when", text: g.dateText + "　" + timeOfDay(d.generatedAt) }));
  if (!isLatest()) box.appendChild(el("span", { class: "issue-old", text: "往期" }));
  box.hidden = false;
}

/** 最上方的頭條跑馬燈：台灣前三則、世界前兩則；滑鼠移上去會暫停 */
function renderTicker(d) {
  const picks = [];
  for (const [k, n] of [["tw", 3], ["world", 2]]) {
    for (const e of (d.regions[k].events || []).slice(0, n)) picks.push(e);
  }
  const box = $("#ticker");
  const track = $("#ticker-track");
  track.textContent = "";
  if (!picks.length) { box.hidden = true; return; }
  const makeSet = (hidden) => {
    const set = el("div", { class: "ticker-set" });
    if (hidden) set.setAttribute("aria-hidden", "true");
    for (const e of picks) {
      const a = el("a", { href: safeHref(e.sources[0] ? e.sources[0].url : "#"), target: "_blank", rel: "noopener noreferrer", text: e.headline });
      if (hidden) a.tabIndex = -1;
      set.appendChild(a);
    }
    return set;
  };
  track.appendChild(makeSet(false));
  track.appendChild(makeSet(true));
  box.hidden = false;
  // 速度固定（約每秒 70px），文字越長繞一圈越久
  requestAnimationFrame(() => {
    const w = track.firstChild.getBoundingClientRect().width;
    track.style.setProperty("--ticker-dur", Math.max(20, Math.round(w / 70)) + "s");
  });
}

function renderStatus(d) {
  const list = $("#status-list");
  list.textContent = "";
  for (const k of TABS) {
    const by = {};
    for (const s of d.regions[k].sources) {
      const g = by[s.name] || (by[s.name] = { ok: 0, fail: 0, count: 0 });
      if (s.ok) { g.ok++; g.count += s.count; } else g.fail++;
    }
    for (const name of Object.keys(by)) {
      const g = by[name];
      const li = el("li");
      if (g.ok === 0) {
        li.className = "bad";
        li.textContent = name + "：讀取失敗";
      } else {
        li.textContent = name + "：取得 " + g.count + " 篇" + (g.fail ? "（另有 " + g.fail + " 個 feed 失敗）" : "");
      }
      list.appendChild(li);
    }
  }
  list.appendChild(el("li", { text: "摘要模型：" + d.model }));
}

/** 平常是空的；只有沒有摘要、讀取失敗、摘要過期時才顯示一行說明 */
function showMsg(text) {
  const m = $("#msg");
  m.textContent = text;
  m.hidden = !text;
}

function renderDigest(d) {
  state.current = d;
  showMsg("");
  for (const k of TABS) renderPanel(k, d.regions[k]);
  renderIssue(d);
  renderTicker(d);
  renderStatus(d);
  renderMenu();
}

function renderEmpty() {
  showMsg("今天的新聞還沒整理出來，排程跑完之後這裡就會有內容。");
  $("#status").hidden = true;
}

const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });

function select(id) {
  if (state.current && state.current.id === id) return;
  getJson("/api/digest?id=" + encodeURIComponent(id))
    .then(
      (j) => { try { renderDigest(j.digest); } catch (err) { console.error(err); } },
      () => showMsg("這一期太久以前了，已經被清掉囉。"),
    );
}

// ── 訪客次數：每次打開網頁加一；失敗就保持隱藏，不影響其他功能 ──────

function initVisits() {
  const show = (n) => {
    if (!Number.isFinite(n) || n < 0) return;
    for (const b of document.querySelectorAll(".visits-n")) b.textContent = n.toLocaleString("en-US");
    for (const p of document.querySelectorAll(".visits")) p.hidden = false;
  };
  fetch("/api/visit", { method: "POST", keepalive: true })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j) => show(j.count))
    .catch(() => {});
}

// ── 右下角的小提示（幾秒後自動消失）──────────────────

let toastTimer = 0;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.remove("out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add("out");
    toastTimer = setTimeout(() => { t.hidden = true; }, 300);
  }, 2000);
}

// ── 側欄選單＋頁面切換（新聞／台股）────────────────

const VIEWS = ["news", "stocks"];
let stocks = null;
let currentView = "news";

function openNav() {
  const nav = $("#sidenav");
  nav.inert = false;
  nav.classList.add("open");
  $("#nav-backdrop").hidden = false;
  $("#menu-toggle").setAttribute("aria-expanded", "true");
  const cur = nav.querySelector('[aria-current="page"]') || nav.querySelector(".nav-item");
  if (cur) cur.focus();
}

function closeNav(opts) {
  const nav = $("#sidenav");
  if (!nav.classList.contains("open")) return;
  nav.classList.remove("open");
  nav.inert = true;
  $("#nav-backdrop").hidden = true;
  $("#menu-toggle").setAttribute("aria-expanded", "false");
  if (!opts || opts.focus !== false) $("#menu-toggle").focus();
}

function setView(view) {
  if (!VIEWS.includes(view)) view = "news";
  currentView = view;
  $("#view-news").hidden = view !== "news";
  $("#view-stocks").hidden = view !== "stocks";
  // 頭條跑馬燈只屬於新聞頁
  $("#ticker").classList.toggle("off", view !== "news");
  for (const b of document.querySelectorAll(".nav-item")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  document.title = view === "stocks" ? "台股 · 看看新聞" : "看看新聞";
  // 網址記住目前的頁面，重新整理後還在同一頁
  history.replaceState(null, "", view === "news" ? location.pathname + location.search : "#" + view);
  if (view === "stocks") {
    if (!stocks) stocks = createStocks({ $, el, store, toast, safeHref });
    stocks.show();
  } else if (stocks) stocks.hide();
}

function initNav() {
  $("#menu-toggle").addEventListener("click", () => ($("#sidenav").classList.contains("open") ? closeNav() : openNav()));
  $("#sidenav-close").addEventListener("click", () => closeNav());
  $("#nav-backdrop").addEventListener("click", () => closeNav());
  document.addEventListener("keydown", (e) => {
    // 意見表單開著時，Esc 只關表單，不連側欄一起關
    if (e.key === "Escape" && $("#sidenav").classList.contains("open") && !document.querySelector(".fb-shade")) closeNav();
  });
  initFeedback({ button: $("#feedback-btn"), endpoint: FEEDBACK_URL, project: FEEDBACK_PROJECT, onToast: toast });
  for (const b of document.querySelectorAll(".nav-item")) {
    b.addEventListener("click", () => {
      closeNav({ focus: false });
      if (b.dataset.view !== currentView) {
        setView(b.dataset.view);
        scrollTo({ top: 0 });
      }
    });
  }
  setView(location.hash.slice(1));
  // 手動改網址的 #stocks、或從書籤跳過來時，也要切換頁面
  addEventListener("hashchange", () => {
    const view = location.hash.slice(1) || "news";
    if (view === currentView) return;
    setView(view);
    scrollTo({ top: 0 });
  });
}

// ── 左上角固定按鈕：橫幅捲出畫面後出現 KANKAN NEWS（點了＝重新整理），選單鈕往右讓位 ──

function initPin() {
  const root = document.documentElement;
  const home = $("#home-pin");
  const toTop = $("#to-top");
  const banner = document.querySelector(".banner");
  const gap = () => parseFloat(getComputedStyle(root).getPropertyValue("--pin-gap")) || 8;
  // 選單鈕要往右移多少＝KANKAN NEWS 的寬度＋間距（字型載入、手機/桌機切換後寬度會變，所以每次重新量）
  const measure = () => root.style.setProperty("--pin-shift", home.offsetWidth + gap() + "px");

  const setPinned = (on) => {
    if (on) measure();
    root.classList.toggle("pinned", on);
    // 沒出現時不能用 Tab 選到，也不唸給螢幕閱讀器
    for (const b of [home, toTop]) {
      b.tabIndex = on ? 0 : -1;
      b.setAttribute("aria-hidden", on ? "false" : "true");
    }
  };

  // 橫幅底部捲到左上角按鈕那一排之上（看不到 KANKAN NEWS 字樣）時釘選
  const pinH = () => parseFloat(getComputedStyle(root).getPropertyValue("--pin-top")) + home.offsetHeight + gap();
  let io = null;
  const observe = () => {
    if (io) io.disconnect();
    io = new IntersectionObserver(([e]) => setPinned(!e.isIntersecting), { rootMargin: `-${Math.round(pinH())}px 0px 0px 0px` });
    io.observe(banner);
  };
  observe();
  addEventListener("resize", () => {
    observe();
    if (root.classList.contains("pinned")) measure();
  });
  if (document.fonts) document.fonts.ready.then(() => root.classList.contains("pinned") && measure());

  home.addEventListener("click", () => location.reload());
  toTop.addEventListener("click", () => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    // 按鈕回到頂端後會消失，焦點交給選單鈕，鍵盤使用者不會迷路
    $("#menu-toggle").focus({ preventScroll: true });
  });

  // 台股表頭黏在按鈕下方時，才把它上面那段縫蓋起來（沒黏住時蓋了會擋到搜尋框）
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const head = document.querySelector("#view-stocks:not([hidden]) .stk-head");
      if (head) head.classList.toggle("stuck", head.getBoundingClientRect().top <= pinH() + 0.5);
    });
  }, { passive: true });
}

// ── 啟動 ────────────────────────────────────────────

initMotion();
initPin();
initNav();
initTheme();
initClock();
initTabs();
initMenu();
initWeather();
initVisits();

const last = store.get(KEY.visit);
state.lastVisit = last ? Number(last) : null;

Promise.all([getJson("/api/latest"), getJson("/api/digests")])
  .then(([latest, idx]) => {
    state.index = idx.digests || [];
    if (!latest.digest) { renderEmpty(); return; }
    // 畫面畫到一半出錯，只記在 console；不能說成「新聞沒載進來」（資料其實已經拿到了）
    try { renderDigest(latest.digest); } catch (err) { console.error(err); }
    store.set(KEY.visit, String(Date.now()));
  })
  .catch(() => {
    showMsg("新聞沒載進來，晚點再重新整理看看。");
  });
