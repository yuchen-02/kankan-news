import { extractFeedImage } from "./images.ts";
import type { RawItem } from "./types.ts";

/**
 * 極簡 RSS / Atom / RDF 解析器。Workers 沒有 DOMParser，所以用正規表示式處理。
 * 只取我們需要的欄位：標題、連結、摘要、發布時間。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, g: string) => {
    if (g[0] === "#") {
      const code = g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[g.toLowerCase()] ?? whole;
  });
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** 把標籤內容轉成乾淨的純文字：拆 CDATA、去 HTML 標籤、解 entity、收斂空白 */
export function cleanText(raw: string): string {
  let t = unwrapCdata(raw);
  t = decodeEntities(t);
  t = t.replace(/<[^>]*>/g, " ");
  t = decodeEntities(t);
  return t.replace(/\s+/g, " ").trim();
}

function tagContent(block: string, names: string[]): string | null {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return m[1];
  }
  return null;
}

function extractLink(block: string): string {
  // RSS / RDF：<link>https://…</link>
  const rss = block.match(/<link(?:\s[^>]*)?>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<\]]+)\s*(?:\]\]>)?\s*<\/link>/i);
  if (rss) return decodeEntities(rss[1]);

  // Atom：<link href="…" rel="alternate" />
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback = "";
  for (const t of tags) {
    const href = t.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const rel = t.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!rel || rel === "alternate") return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  if (fallback) return fallback;

  // 最後手段：permalink 形式的 guid
  const guid = tagContent(block, ["guid", "id"]);
  if (guid) {
    const g = cleanText(guid);
    if (/^https?:\/\//i.test(g)) return g;
  }
  return "";
}

function parseDate(block: string): number | null {
  const raw = tagContent(block, ["pubDate", "dc:date", "published", "updated", "date"]);
  if (!raw) return null;
  const ms = Date.parse(cleanText(raw));
  return Number.isFinite(ms) ? ms : null;
}

export function parseFeed(xml: string): RawItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const items: RawItem[] = [];
  for (const block of blocks) {
    const titleRaw = tagContent(block, ["title"]);
    const title = titleRaw ? cleanText(titleRaw) : "";
    const url = extractLink(block);
    if (!title || !/^https?:\/\//i.test(url)) continue;

    const snippetRaw = tagContent(block, ["description", "summary", "content:encoded", "content"]);
    const snippet = snippetRaw ? cleanText(snippetRaw).slice(0, 300) : "";

    const item: RawItem = { title, url, snippet, publishedAt: parseDate(block) };
    const imageUrl = extractFeedImage(decodeEntities(unwrapCdata(block)));
    if (imageUrl) item.imageUrl = imageUrl;
    items.push(item);
  }
  return items;
}
