import test from "node:test";
import assert from "node:assert/strict";
import { cleanText, parseFeed } from "../src/rss.ts";
import { extractOgImage, usableImageUrl } from "../src/images.ts";
import { extractJson, parseEvents } from "../src/summarizers/json.ts";

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>x</title><link>https://example.com</link>
<item>
  <title><![CDATA[總統府：今日表示 &amp; 回應]]></title>
  <link>https://news.example.com/a?utm=1</link>
  <description><![CDATA[<p>第一段 &nbsp;內容</p><img src="x.jpg"/>]]></description>
  <pubDate>Wed, 04 Nov 2026 08:30:00 +0800</pubDate>
</item>
<item>
  <title>No link item</title>
  <pubDate>Wed, 04 Nov 2026 08:31:00 +0800</pubDate>
</item>
</channel></rss>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item rdf:about="https://dw.example/1">
  <title>DW headline &#8211; test</title>
  <link>https://dw.example/1</link>
  <description>Desc &lt;b&gt;bold&lt;/b&gt;</description>
  <dc:date>2026-11-04T01:00:00Z</dc:date>
</item></rdf:RDF>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Atom title</title>
  <link rel="self" href="https://a.example/self"/>
  <link rel="alternate" href="https://a.example/post?x=1&amp;y=2"/>
  <summary>Atom summary</summary>
  <updated>2026-11-04T02:00:00+00:00</updated>
</entry></feed>`;

test("RSS 2.0：CDATA、entity、HTML 標籤與缺連結的項目", () => {
  const items = parseFeed(RSS2);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "總統府：今日表示 & 回應");
  assert.equal(items[0].url, "https://news.example.com/a?utm=1");
  assert.equal(items[0].snippet, "第一段 內容");
  assert.equal(items[0].publishedAt, Date.parse("2026-11-04T00:30:00Z"));
});

test("RDF：dc:date 與數字 entity", () => {
  const [it] = parseFeed(RDF);
  assert.equal(it.title, "DW headline – test");
  assert.equal(it.snippet, "Desc bold");
  assert.equal(it.publishedAt, Date.parse("2026-11-04T01:00:00Z"));
});

test("Atom：選 alternate 連結並解 &amp;", () => {
  const [it] = parseFeed(ATOM);
  assert.equal(it.url, "https://a.example/post?x=1&y=2");
  assert.equal(it.publishedAt, Date.parse("2026-11-04T02:00:00Z"));
});

test("cleanText 收斂空白", () => {
  assert.equal(cleanText("  a \n\n b\t c "), "a b c");
});

test("extractJson 容忍 markdown 圍欄與前後文字", () => {
  const out = extractJson('好的，結果如下：\n```json\n{"events":[]}\n```\n以上') as { events: unknown[] };
  assert.deepEqual(out.events, []);
  assert.throws(() => extractJson("沒有 json"));
});

test("parseEvents：類型標籤只留清單內的、去重、最多 3 個", () => {
  const out = parseEvents(
    JSON.stringify({
      events: [
        { headline: "A", summary: "s", disputed: null, articleIds: [1], categories: ["經濟", "政治", "經濟", "亂編的類型", "司法", "犯罪"] },
        { headline: "B", summary: "s", disputed: null, articleIds: [1], categories: "經濟" },
        { headline: "C", summary: "s", disputed: null, articleIds: [1] },
      ],
    }),
    3,
  );
  assert.deepEqual(out[0].categories, ["經濟", "政治", "司法"]);
  assert.equal(out[1].categories, undefined);
  assert.equal(out[2].categories, undefined);
});

test("parseEvents：丟掉無效編號、空欄位，並處理 disputed", () => {
  const text = JSON.stringify({
    events: [
      { headline: "A", summary: "sa", disputed: null, articleIds: [1, 2, 2, 99, "3"] },
      { headline: "B", summary: "sb", disputed: "無", articleIds: [4] },
      { headline: "", summary: "x", articleIds: [1] },
      { headline: "C", summary: "sc", articleIds: [99] },
      { headline: "D", summary: "sd", disputed: "兩家說法不同", articleIds: [1] },
    ],
  });
  const out = parseEvents(text, 5);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].articleIds, [1, 2, 3]);
  assert.equal(out[1].disputed, null);
  assert.equal(out[2].disputed, "兩家說法不同");
});

test("RSS 圖片：media:thumbnail、enclosure、內文 <img>；相對網址與通用圖會被忽略", () => {
  const xml = `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
  <item><title>a</title><link>https://x.test/a</link><media:thumbnail width="240" url="http://img.test/a.jpg"/></item>
  <item><title>b</title><link>https://x.test/b</link><enclosure url="https://img.test/b.png" type="image/png" length="1"/></item>
  <item><title>c</title><link>https://x.test/c</link><description><![CDATA[<p>hi</p><img src="https://img.test/c.jpg?x=1&amp;y=2">]]></description></item>
  <item><title>d</title><link>https://x.test/d</link><description>&lt;img src="https://img.test/d.jpg"&gt;</description></item>
  <item><title>e</title><link>https://x.test/e</link><description><![CDATA[<img src="x.jpg">]]></description></item>
  <item><title>f</title><link>https://x.test/f</link><enclosure url="https://img.test/f.mp3" type="audio/mpeg"/></item>
  <item><title>g</title><link>https://x.test/g</link><media:thumbnail url="https://x.test/images/pic_fb.jpg"/></item>
  </channel></rss>`;
  const by = Object.fromEntries(parseFeed(xml).map((i) => [i.title, i.imageUrl]));
  assert.equal(by.a, "https://img.test/a.jpg"); // http 會升級成 https
  assert.equal(by.b, "https://img.test/b.png");
  assert.equal(by.c, "https://img.test/c.jpg?x=1&y=2");
  assert.equal(by.d, "https://img.test/d.jpg");
  assert.equal(by.e, undefined);
  assert.equal(by.f, undefined);
  assert.equal(by.g, undefined);
});

test("og:image：兩種屬性順序、通用圖與非 http(s) 都處理", () => {
  assert.equal(extractOgImage('<meta property="og:image" content="https://i.test/1.jpg">'), "https://i.test/1.jpg");
  assert.equal(extractOgImage('<meta content="https://i.test/2.jpg" property="og:image" />'), "https://i.test/2.jpg");
  assert.equal(extractOgImage('<meta property="og:image" content="https://www.cna.com.tw/images/pic_fb.jpg">'), null);
  assert.equal(extractOgImage('<meta name="twitter:image" content="https://i.test/3.jpg">'), "https://i.test/3.jpg");
  assert.equal(usableImageUrl("javascript:alert(1)"), null);
  assert.equal(usableImageUrl("data:image/png;base64,AAAA"), null);
  assert.equal(usableImageUrl(""), null);
});
