/**
 * 縮圖：先看 RSS 本身有沒有帶圖，沒有的話再去讀文章網頁的 og:image。
 * 圖片只記網址（直接引用媒體的圖），不下載、不存檔。
 */

// 常見的「網站預設圖／logo／追蹤像素」，不當作新聞照片
const GENERIC = /pic_fb|logo|favicon|placeholder|default[-_.]|spacer|pixel|1x1|tracking|blank\.|noimage|no-image/i;

/** 只接受 https（http 會被瀏覽器當成混合內容擋掉，所以 http 先升級成 https）的絕對網址 */
export function usableImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return null;
  const s = u.toString();
  if (s.length > 600 || GENERIC.test(s)) return null;
  return s;
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

/** 從單一 <item>/<entry> 的原始內容找圖片網址：media:thumbnail > media:content > enclosure > 內文第一張 <img> */
export function extractFeedImage(decodedBlock: string): string | null {
  for (const tag of decodedBlock.match(/<media:thumbnail\b[^>]*>/gi) ?? []) {
    const u = usableImageUrl(attr(tag, "url"));
    if (u) return u;
  }
  for (const tag of decodedBlock.match(/<media:content\b[^>]*>/gi) ?? []) {
    const url = attr(tag, "url");
    const isImage = /image/i.test(attr(tag, "medium") ?? "") || /^image\//i.test(attr(tag, "type") ?? "") || (url !== null && IMG_EXT.test(url));
    if (!isImage) continue;
    const u = usableImageUrl(url);
    if (u) return u;
  }
  for (const tag of decodedBlock.match(/<enclosure\b[^>]*>/gi) ?? []) {
    if (!/^image\//i.test(attr(tag, "type") ?? "")) continue;
    const u = usableImageUrl(attr(tag, "url"));
    if (u) return u;
  }
  for (const tag of decodedBlock.match(/<img\b[^>]*>/gi) ?? []) {
    const u = usableImageUrl(attr(tag, "src"));
    if (u) return u;
  }
  return null;
}

/** 從網頁 HTML 的 <head> 找 og:image / twitter:image */
export function extractOgImage(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const key of ["og:image", "twitter:image"]) {
    for (const tag of metas) {
      const k = attr(tag, "property") ?? attr(tag, "name");
      if (k?.toLowerCase() !== key) continue;
      const content = attr(tag, "content");
      if (content) {
        const u = usableImageUrl(content.replace(/&amp;/g, "&"));
        if (u) return u;
      }
    }
  }
  return null;
}

/** 讀文章網頁前 96 KB（og:image 在 <head> 裡），不下載整頁 */
export async function fetchOgImage(pageUrl: string, f: typeof fetch): Promise<string | null> {
  try {
    const res = await f(pageUrl, {
      headers: { "user-agent": "news-digest/1.0 (personal RSS digest)", accept: "text/html,*/*" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < 96_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    return extractOgImage(html);
  } catch {
    return null;
  }
}
