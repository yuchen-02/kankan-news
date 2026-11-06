// 版面樣本伺服器：不連 Cloudflare、不碰 KV、不呼叫 AI，只用假新聞把 public/ 的頁面跑起來，用來檢查版面。
//
//   node dev/mock-server.mjs         然後打開 http://localhost:8001/__samples
//
// 圖片用 picsum.photos 依指定尺寸產生（需要網路），不同尺寸用來測試橫圖、直圖、方圖、超寬圖。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const PORT = Number(process.env.PORT) || 8001;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

// ── 假資料 ──────────────────────────────────────────
const img = (seed, w, h) => `https://picsum.photos/seed/${seed}/${w}/${h}`;
const LAND = (s) => img(s, 800, 450); // 橫圖
const PORT_ = (s) => img(s, 450, 700); // 直圖
const SQ = (s) => img(s, 600, 600); // 方圖
const WIDE = (s) => img(s, 1200, 400); // 超寬圖

let n = 0;
function ev(headline, summary, sources, { cats, image, images, disputed = null } = {}) {
  n++;
  return {
    headline, summary, disputed,
    categories: cats, imageUrl: image || (images && images[0]), ...(images && images.length > 1 ? { imageUrls: images } : {}),
    sources: sources.map((name) => ({ name, url: "https://example.com/" + n + "/" + encodeURIComponent(name), title: headline })),
    sourceCount: sources.length,
  };
}

const S1 = "高金素梅涉嫌接受中共官員指示，為中國公務機構發展組織，並透過在立院反對軍購、兩岸、外交及國防等議案，影響我國議事進行。檢方指出，高金素梅涉嫌違反《國安法》、《貪污治罪條例》等罪，求處14年有期徒刑。";
const S2 = "台股連日重挫，今天開盤再崩跌逾3700點，失守40000點關卡。隨著外資匯出浪潮不停歇，新台幣貶勢加劇，摜破33元整數大關。";
const S3 = "洛杉磯市長選舉結果出爐，民主社會主義者拉曼勝出。";
const S4 = "教廷與中國天主教會進行罕見的公開對話，教廷強調中國教會應與普世教會共融。";

const TW = {
  lead2: () => ev("美光桃園工會質疑台中協議效力", "美光桃園工會質疑美光台中工會與公司簽署的協議效力，勞團在今（4）日勞動部長到立院備詢時到立院外抗議。部長回應，台中美光的協議具有法律效力。", ["公視新聞網", "中央社"], { cats: ["經濟", "政治"], images: [LAND("a"), LAND("b")] }),
  lead1: () => ev("美光桃園工會質疑台中協議效力", "美光桃園工會質疑美光台中工會與公司簽署的協議效力，勞團在今（4）日勞動部長到立院備詢時到立院外抗議。部長回應，台中美光的協議具有法律效力。", ["公視新聞網"], { cats: ["經濟", "政治"], image: LAND("c") }),
  leadNone: () => ev("美光桃園工會質疑台中協議效力", "美光桃園工會質疑美光台中工會與公司簽署的協議效力，勞團在今（4）日勞動部長到立院備詢時到立院外抗議。", ["公視新聞網"], { cats: ["經濟", "政治"] }),
  a: () => ev("高金素梅涉收1.7億為中共發展組織", S1, ["公視新聞網"], { cats: ["政治", "司法"], image: LAND("d") }),
  b: () => ev("台股重挫失守4萬點", S2, ["中央社"], { cats: ["經濟"], image: PORT_("e") }),
  c: () => ev("洛杉磯市長選舉結果出爐", S3, ["BBC", "Al Jazeera"], { cats: ["政治"], image: SQ("f") }),
  d: () => ev("教廷與中國天主教會對話", S4, ["中央社（國際）"], { cats: ["文化"], image: WIDE("g") }),
  noimg: () => ev("巴拉圭新總統宣誓就職", "巴拉圭新任總統今天在亞松森宣誓就職，承諾推動經濟改革。", ["中央社（國際）"], { cats: ["政治", "外交"] }),
  noimg2: () => ev("加州野火延燒逾千公頃", "加州北部野火持續延燒，消防單位出動直升機灑水，已有數千居民撤離。", ["BBC", "DW"], { cats: ["災害", "環境"] }),
  dispute: () => ev("巴布亞紐幾內亞發現中國製炮彈", "巴布亞紐幾內亞警方發現一枚中國製的 59 式 130 毫米炮彈，中國使館聲稱只是酒瓶。", ["中央社（國際）"], { cats: ["外交", "軍事"], image: LAND("h"), disputed: "中國使館與巴布亞紐幾內亞警方對炮彈性質有不同說法" }),
  longTitle: () => ev("高金素梅前助理涉嫌接受中共官員指示並透過立法院反對軍購案，檢方求處十四年有期徒刑並聲請沒收犯罪所得", S1 + S1, ["公視新聞網", "中央社", "自由時報", "聯合新聞網", "三立新聞網"], { cats: ["政治", "司法", "犯罪"], image: LAND("i") }),
  veryLongSummary: () => ev("一個很長很長的摘要測試", "這是一段刻意寫得很長的摘要，用來測試卡片在文字很多時的版面。".repeat(8), ["中央社"], { cats: ["社會"], image: PORT_("j") }),
};
const WORLD = {
  lead2: () => ev("美國期中選舉結果", "民主黨贏得眾議院和參議院控制權，對總統川普是一記重擊。", ["BBC", "DW", "Al Jazeera", "中央社（國際）"], { cats: ["外交", "政治"], images: [LAND("w1"), PORT_("w2")] }),
  lead1: () => ev("美國期中選舉結果", "民主黨贏得眾議院和參議院控制權，對總統川普是一記重擊。", ["BBC", "DW"], { cats: ["外交", "政治"], image: LAND("w3") }),
  a: () => ev("日本與南韓同意恢復領袖互訪", "兩國外長今天在首爾宣布，將在明年初安排領袖互訪。", ["DW"], { cats: ["外交"], image: LAND("w4") }),
  b: () => ev("德里空氣質量惡化", "印度首都德里空氣污染指數連日爆表，當局下令學校停課。", ["中央社（國際）"], { cats: ["環境", "健康"], image: SQ("w5") }),
  c: () => ev("美股重挫 費半跌逾3%", "美股四大指數全面收黑，市場擔憂科技股估值過高。", ["BBC"], { cats: ["經濟"], image: WIDE("w6") }),
  noimg: () => ev("烏克蘭與俄羅斯交換戰俘", "兩國今天各自釋放數百名戰俘，由第三國居中協調。", ["DW", "BBC"], { cats: ["軍事", "外交"] }),
};

const SCENARIOS = {
  normal: { title: "一般：頭條雙圖＋混合比例的圖（橫、直、方、超寬）＋有／無圖", tw: () => [TW.lead2(), TW.a(), TW.b(), TW.c(), TW.d(), TW.noimg(), TW.dispute()], world: () => [WORLD.lead2(), WORLD.a(), WORLD.b(), WORLD.c(), WORLD.noimg()] },
  "lead-one-image": { title: "頭條只有一張圖（圖左文右）", tw: () => [TW.lead1(), TW.a(), TW.b(), TW.noimg()], world: () => [WORLD.lead1(), WORLD.a(), WORLD.noimg()] },
  "lead-no-image": { title: "頭條沒有圖", tw: () => [TW.leadNone(), TW.a(), TW.b(), TW.c()], world: () => [WORLD.noimg(), WORLD.a()] },
  "no-images": { title: "全部都沒有圖（佔位圖）", tw: () => [TW.leadNone(), TW.noimg(), TW.noimg2(), TW.noimg()], world: () => [WORLD.noimg(), WORLD.noimg(), WORLD.noimg()] },
  "all-images": { title: "全部都有圖，比例各不相同", tw: () => [TW.lead2(), TW.a(), TW.b(), TW.c(), TW.d(), TW.dispute()], world: () => [WORLD.lead2(), WORLD.a(), WORLD.b(), WORLD.c()] },
  long: { title: "很長的標題、很長的摘要、3 個標籤、很多來源", tw: () => [TW.leadNone(), TW.longTitle(), TW.veryLongSummary(), TW.a(), TW.b()], world: () => [WORLD.lead1(), WORLD.a()] },
  "odd-count": { title: "緊湊卡片是單數（最後一張佔滿整列）", tw: () => [TW.lead2(), TW.a(), TW.b(), TW.c()], world: () => [WORLD.lead1(), WORLD.a(), WORLD.noimg()] },
  few: { title: "很少新聞：台灣只有 1 則、世界沒有", tw: () => [TW.lead1()], world: () => [] },
  dense: { title: "8 則（正式上線的最大量）", tw: () => [TW.lead2(), TW.a(), TW.b(), TW.c(), TW.d(), TW.noimg(), TW.noimg2(), TW.dispute()], world: () => [WORLD.lead2(), WORLD.a(), WORLD.b(), WORLD.c(), WORLD.noimg(), WORLD.a(), WORLD.b(), WORLD.noimg()] },
};

const now = Date.now();
function digest(name, hoursAgo, sc) {
  const gen = new Date(now - hoursAgo * 3600_000).toISOString();
  const tw = sc.tw(), world = sc.world();
  return {
    id: name + "-" + hoursAgo, generatedAt: gen, windowStart: new Date(now - (hoursAgo + 6) * 3600_000).toISOString(), windowEnd: gen,
    summarizer: "sample", model: "sample",
    regions: {
      tw: { articleCount: tw.length ? 40 : 0, sources: [{ name: "中央社", ok: true, count: 25 }, { name: "公視新聞網", ok: true, count: 15 }], events: tw },
      world: { articleCount: world.length ? 30 : 0, sources: [{ name: "BBC", ok: true, count: 12 }, { name: "DW", ok: true, count: 8 }], events: world },
    },
  };
}

let current = "normal";
let visits = 1234;
function build() {
  const sc = SCENARIOS[current];
  const list = Array.from({ length: 12 }, (_, i) => digest(current, 0.5 + i * 7, sc)); // 一天約三期，做出幾天的時間選單
  return { list, index: list.map((d) => ({ id: d.id, generatedAt: d.generatedAt, windowStart: d.windowStart, windowEnd: d.windowEnd, counts: { tw: d.regions.tw.events.length, world: d.regions.world.events.length } })) };
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type = "application/json; charset=utf-8", extra = {}) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

  if (u.pathname === "/__samples") {
    const items = Object.entries(SCENARIOS).map(([k, v]) => `<li><a href="/__s/${k}"><b>${k}</b></a>　${v.title}${k === current ? "　← 目前" : ""}</li>`).join("");
    return send(200, `<!doctype html><meta charset="utf-8"><title>版面樣本</title><body style="font:16px/1.9 sans-serif;max-width:760px;margin:30px auto;padding:0 16px"><h1>版面樣本</h1><p>點一個樣本會回到首頁，台灣／世界兩個分頁都可以看。</p><ul>${items}</ul>`, "text/html; charset=utf-8");
  }
  if (u.pathname.startsWith("/__s/")) {
    const k = decodeURIComponent(u.pathname.slice(5));
    if (SCENARIOS[k]) current = k;
    return send(302, "", "text/plain", { location: "/" });
  }
  if (u.pathname === "/api/visit") { visits += 1; return send(200, { count: visits }); }
  if (u.pathname === "/api/visits") return send(200, { count: visits });
  if (u.pathname === "/api/latest") return send(200, { digest: build().list[0] });
  if (u.pathname === "/api/digests") return send(200, { digests: build().index });
  if (u.pathname === "/api/digest") {
    const d = build().list.find((x) => x.id === u.searchParams.get("id"));
    return d ? send(200, { digest: d }) : send(404, { error: "not found" });
  }
  const p = u.pathname === "/" ? "/index.html" : u.pathname;
  const f = path.join(ROOT, decodeURIComponent(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, "not found", "text/plain");
  send(200, fs.readFileSync(f), TYPES[path.extname(f)] || "application/octet-stream");
}).listen(PORT, () => console.log(`版面樣本：http://localhost:${PORT}/__samples`));
