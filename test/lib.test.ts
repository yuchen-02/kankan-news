import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore 前端用的純 JS 模組
import * as lib from "../public/lib.js";

test("formatClock：指定時區輸出日期星期與 24 小時制時間", () => {
  const d = new Date(Date.UTC(2026, 10, 4, 8, 42)); // 2026-11-04 16:42 台北
  const c = lib.formatClock(d, "Asia/Taipei");
  assert.equal(c.timeText, "16:42");
  assert.equal(c.dateText, "11/4 三");
});

test("formatClock：午夜是 00:xx 不是 24:xx", () => {
  const d = new Date(Date.UTC(2026, 10, 4, 16, 5)); // 台北 00:05
  assert.equal(lib.formatClock(d, "Asia/Taipei").timeText, "00:05");
});

test("formatClock：不合法的時區退回台北，不會丟錯", () => {
  const d = new Date(Date.UTC(2026, 10, 4, 8, 42));
  assert.equal(lib.formatClock(d, "Not/AZone").timeText, "16:42");
});

test("tempLevel／humidityLevel／rainLevel：邊界與缺值", () => {
  const t = (n: number) => lib.tempLevel(n).label;
  assert.deepEqual([5, 10, 11, 17, 21, 25, 26, 30, 31, 34, 35].map(t), ["寒冷", "寒冷", "涼爽", "涼爽", "舒適", "舒適", "溫暖", "溫暖", "炎熱", "炎熱", "酷熱"]);
  const h = (n: number) => lib.humidityLevel(n).label;
  assert.deepEqual([20, 39, 40, 70, 71, 85, 86].map(h), ["乾燥", "乾燥", "舒適", "舒適", "潮濕", "潮濕", "很潮濕"]);
  const r = (n: number) => lib.rainLevel(n).key;
  assert.deepEqual([0, 19, 20, 49, 50, 79, 80, 100].map(r), ["low", "low", "mid", "mid", "high", "high", "veryhigh", "veryhigh"]);
  assert.equal(lib.rainLevel(null as any).key, "none");
  assert.equal(lib.tempLevel(NaN).key, "none");
});

test("slotLabel：早上／中午／晚上（07:00、12:00、18:00 的排程各落在哪一段）", () => {
  const f = (iso: string) => lib.slotLabelOf(iso, "Asia/Taipei");
  assert.equal(f("2026-11-04T23:00:00Z"), "早上"); // 台北 07:00
  assert.equal(f("2026-11-05T04:00:00Z"), "中午"); // 台北 12:00
  assert.equal(f("2026-11-05T10:00:00Z"), "晚上"); // 台北 18:00
  assert.equal(f("2026-11-05T10:01:30Z"), "晚上"); // 排程有幾分鐘誤差
  assert.equal(f("2026-11-04T16:00:00Z"), "深夜"); // 台北 00:00（舊排程）
  assert.deepEqual([0, 4, 5, 10, 11, 14, 15, 23].map(lib.slotLabel), ["深夜", "深夜", "早上", "早上", "中午", "中午", "晚上", "晚上"]);
});

test("editionName：早報／午報／晚報", () => {
  const f = (iso: string) => lib.editionName(iso, "Asia/Taipei");
  assert.equal(f("2026-11-04T23:00:00Z"), "早報"); // 台北 07:00
  assert.equal(f("2026-11-05T04:00:00Z"), "午報"); // 台北 12:00
  assert.equal(f("2026-11-05T10:00:00Z"), "晚報"); // 台北 18:00
  assert.equal(f("2026-11-04T16:00:00Z"), "深夜版"); // 台北 00:00
});

test("groupByDay：依天分組、新的在前、今天／昨天標籤", () => {
  const now = Date.parse("2026-11-05T01:00:00Z"); // 台北 11/05 09:00
  const e = (iso: string) => ({ id: iso, generatedAt: iso });
  const groups = lib.groupByDay(
    [e("2026-11-03T23:00:00Z"), e("2026-11-04T16:00:00Z"), e("2026-11-04T08:00:00Z"), e("2026-11-04T04:00:00Z"), e("2026-11-01T04:00:00Z"), e("garbage")],
    now,
    "Asia/Taipei",
  );
  assert.deepEqual(groups.map((g: any) => g.key), ["2026-11-05", "2026-11-04", "2026-11-01"]);
  assert.deepEqual(groups.map((g: any) => g.label), ["今天", "昨天", "11/1 日"]);
  assert.deepEqual(groups[0].items.map((i: any) => i.id), ["2026-11-04T16:00:00Z"]);
  assert.deepEqual(groups[1].items.map((i: any) => i.id), ["2026-11-04T08:00:00Z", "2026-11-04T04:00:00Z", "2026-11-03T23:00:00Z"]);
  assert.equal(lib.timeOfDay("2026-11-04T16:00:00Z", "Asia/Taipei"), "00:00");
  assert.deepEqual(lib.groupByDay([], now, "Asia/Taipei"), []);
});

test("dayPart：各時段的邊界", () => {
  const k = (h: number) => lib.dayPart(h).key;
  assert.deepEqual([0, 4, 5, 10, 11, 13, 14, 17, 18, 19, 20, 23].map(k), [
    "night", "night", "morning", "morning", "noon", "noon", "afternoon", "afternoon", "dusk", "dusk", "evening", "evening",
  ]);
  assert.equal(lib.dayPart(8).label, "早上");
  assert.equal(lib.dayPart(NaN).key, "night");
  assert.equal(lib.dayPart(24).key, "night");
});

test("segmentsFor：七段顯示器各數字亮的段", () => {
  assert.equal(lib.segmentsFor("8"), "abcdefg");
  assert.equal(lib.segmentsFor("1"), "bc");
  assert.equal(lib.segmentsFor(":"), null);
  for (const d of "0123456789") assert.ok(lib.segmentsFor(d), d);
});

test("placeNameFromGeocode：縣市＋區；相同只顯示一次；缺資料回傳 null", () => {
  assert.equal(lib.placeNameFromGeocode({ city: "臺北市", locality: "信義區", principalSubdivision: "臺北市" }), "臺北市 信義區");
  assert.equal(lib.placeNameFromGeocode({ city: "東京都", locality: "東京都" }), "東京都");
  assert.equal(lib.placeNameFromGeocode({ city: "", locality: "板橋區", principalSubdivision: "新北市" }), "新北市 板橋區");
  assert.equal(lib.placeNameFromGeocode({}), null);
  assert.equal(lib.placeNameFromGeocode(null), null);
});

test("reverseGeocodeUrl：座標四捨五入到 2 位", () => {
  const u = new URL(lib.reverseGeocodeUrl(25.03751234, 121.56371234));
  assert.equal(u.searchParams.get("latitude"), "25.04");
  assert.equal(u.searchParams.get("longitude"), "121.56");
});

test("resolveTimeZone：回傳可用的時區字串", () => {
  const r = lib.resolveTimeZone();
  assert.equal(typeof r.tz, "string");
  assert.equal(typeof r.fallback, "boolean");
});

test("fmtDateTime：格式 MM/DD HH:mm", () => {
  assert.equal(lib.fmtDateTime("2026-11-04T08:00:00Z", "Asia/Taipei"), "11/04 16:00");
});

test("relativeFromNow", () => {
  const now = Date.UTC(2026, 10, 4, 12);
  assert.equal(lib.relativeFromNow(now - 10 * 60_000, now), "不到一小時前");
  assert.equal(lib.relativeFromNow(now - 5 * 3600_000, now), "5 小時前");
  assert.equal(lib.relativeFromNow(now - 72 * 3600_000, now), "3 天前");
});

test("resolveTheme：有儲存的選擇優先，否則跟隨使用者本機設定", () => {
  assert.equal(lib.resolveTheme("light", true), "light");
  assert.equal(lib.resolveTheme("dark", false), "dark");
  assert.equal(lib.resolveTheme(null, true), "dark");
  assert.equal(lib.resolveTheme("garbage", false), "light");
  assert.equal(lib.nextTheme("dark"), "light");
  assert.equal(lib.nextTheme("light"), "dark");
});

test("tabFromHash：hash > 儲存 > 預設台灣", () => {
  assert.equal(lib.tabFromHash("#world", "tw"), "world");
  assert.equal(lib.tabFromHash("", "world"), "world");
  assert.equal(lib.tabFromHash("#nope", null), "tw");
  assert.equal(lib.tabFromHash(undefined, "bad"), "tw");
});

test("weatherUrl：座標四捨五入到 2 位，並帶齊需要的欄位", () => {
  const u = new URL(lib.weatherUrl(25.03751234, 121.56371234));
  assert.equal(u.host, "api.open-meteo.com");
  assert.equal(u.searchParams.get("latitude"), "25.04");
  assert.equal(u.searchParams.get("longitude"), "121.56");
  assert.equal(u.searchParams.get("current"), "temperature_2m,relative_humidity_2m");
  assert.equal(u.searchParams.get("hourly"), "precipitation_probability");
});

test("parseWeather：取現在這個整點的降雨機率", () => {
  const j = {
    current: { time: "2026-11-04T16:30", temperature_2m: 23.6, relative_humidity_2m: 71.2 },
    hourly: {
      time: ["2026-11-04T15:00", "2026-11-04T16:00", "2026-11-04T17:00"],
      precipitation_probability: [10, 35, 60],
    },
  };
  assert.deepEqual(lib.parseWeather(j), { temp: 24, humidity: 71, rain: 35 });
});

test("parseWeather：找不到整點時 rain 為 null；資料不完整回傳 null", () => {
  const j = { current: { time: "2026-11-04T16:30", temperature_2m: 20, relative_humidity_2m: 80 }, hourly: { time: [], precipitation_probability: [] } };
  assert.deepEqual(lib.parseWeather(j), { temp: 20, humidity: 80, rain: null });
  assert.equal(lib.parseWeather({}), null);
  assert.equal(lib.parseWeather({ current: { temperature_2m: null, relative_humidity_2m: 1 } }), null);
  assert.equal(lib.parseWeather(null), null);
});

const texts = (r: any) => r.parts.map((p: any) => p.text).join("");

test("markCountries：標出國名，別名同國碼，依出現順序", () => {
  const r = lib.markCountries("美國與中國大陸官員會談，台灣關注");
  assert.deepEqual(r.codes, ["us", "cn", "tw"]);
  assert.equal(texts(r), "美國與中國大陸官員會談，台灣關注");
  assert.deepEqual(r.parts.filter((p: any) => p.code).map((p: any) => p.text), ["美國", "中國大陸", "台灣"]);
  assert.deepEqual(lib.markCountries("中共與大陸方面回應").codes, ["cn"]);
  assert.equal(lib.toneOf("cn"), lib.toneOf("cn"));
});

test("markCountries：只寫城市也要標出國家（同一則新聞不同次摘要的標題不一定有國名）", () => {
  assert.deepEqual(lib.markCountries("德里空氣質量惡化").codes, ["in"]);
  assert.deepEqual(lib.markCountries("印度德里空氣質量惡化").codes, ["in"]);
  assert.deepEqual(lib.markCountries("莫斯科與基輔互相指控").codes, ["ru", "ua"]);
  assert.deepEqual(lib.markCountries("羅馬尼亞選舉").codes, ["ro"]); // 是羅馬尼亞，不是義大利的羅馬
});

test("markCountries：skip 可略過台灣（台灣分頁用）", () => {
  const r = lib.markCountries("台灣與日本簽署協議", ["tw"]);
  assert.deepEqual(r.codes, ["jp"]);
  assert.equal(texts(r), "台灣與日本簽署協議");
});

test("markCountries：常見誤判不會標記", () => {
  assert.deepEqual(lib.markCountries("中國信託發布財報").codes, []);
  assert.deepEqual(lib.markCountries("立法院長韓國瑜表示").codes, []);
  assert.deepEqual(lib.markCountries("印度洋出現地震").codes, []);
  assert.deepEqual(lib.markCountries("歐洲大陸寒流來襲").codes, []);
  assert.deepEqual(lib.markCountries("南蘇丹局勢緊張").codes, []);
  assert.deepEqual(lib.markCountries("沒有國名的標題").codes, []);
  assert.deepEqual(lib.markCountries("").parts, []);
});

test("toneOf：每個國碼都落在 0 到 11", () => {
  for (const { code } of lib.COUNTRIES) {
    const t = lib.toneOf(code);
    assert.ok(Number.isInteger(t) && t >= 0 && t < lib.COUNTRY_TONES, code);
  }
});

test("markCountries：補上的國家、美國的州與城市、美股等金融用語", () => {
  const codes = (t: string) => lib.markCountries(t).codes;
  assert.deepEqual(codes("巴拉圭新總統就職"), ["py"]);
  assert.deepEqual(codes("加州野火延燒"), ["us"]);
  assert.deepEqual(codes("美股重挫 費半跌逾3%"), ["us"]);
  assert.deepEqual(codes("華爾街預期聯準會降息"), ["us"]);
  assert.deepEqual(codes("日股收盤創新高"), ["jp"]);
  assert.deepEqual(codes("台股跌破4萬點"), ["tw"]);
  assert.deepEqual(lib.markCountries("台股跌破4萬點", ["tw"]).codes, []); // 台灣分頁不標台灣
});

test("markCountries：容易誤判的詞不標", () => {
  const codes = (t: string) => lib.markCountries(t).codes;
  assert.deepEqual(codes("美光桃園工會質疑協議效力"), []); // 美光是公司
  assert.deepEqual(codes("約旦河西岸衝突"), []); // 河西岸不是約旦國
  assert.deepEqual(codes("喬治亞州選務爭議"), []); // 是美國的州，不是喬治亞國
  assert.deepEqual(codes("德州撲克世界賽"), []);
  assert.deepEqual(codes("哥倫比亞大學學生抗議"), []);
});

test("cardCountries：標題有國家就照標題；標題一個國家都沒有，才用摘要裡第一個出現的國家補國旗（不標底色）", () => {
  const a = lib.cardCountries("美國期中選舉結果", "民主黨取得眾議院過半", []);
  assert.deepEqual(a.codes, ["us"]);
  assert.equal(a.fromSummary, false);

  const b = lib.cardCountries("野火延燒", "美國東部沿岸出現大火，日本也派員協助", []);
  assert.deepEqual(b.codes, ["us"]); // 只補第一個
  assert.equal(b.fromSummary, true);
  assert.ok(b.parts.every((p: { code?: string }) => !p.code)); // 標題文字不上底色

  const c = lib.cardCountries("野火延燒", "當地消防單位表示已控制火勢", []);
  assert.deepEqual(c.codes, []);
  assert.equal(c.fromSummary, false);
});

test("cardCountries：台灣分頁裡標題提到台灣（雖然不標）也算標題有國家，不再去摘要補", () => {
  const r = lib.cardCountries("台灣出口創新高", "主要客戶為美國與中國", ["tw"]);
  assert.deepEqual(r.codes, []);
  assert.equal(r.fromSummary, false);
  const r2 = lib.cardCountries("工會質疑協議效力", "美光在桃園的工廠與日本供應商", ["tw"]);
  assert.deepEqual(r2.codes, ["jp"]); // 台灣分頁摘要裡的台灣不補；「美光」不是國家
});
