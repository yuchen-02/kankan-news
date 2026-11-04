import type { Region } from "./types.ts";

export interface Feed {
  region: Region;
  /** 顯示用的來源名稱。同一個名稱的多個 feed 會被當成同一家媒體。 */
  name: string;
  url: string;
}

/** 每家媒體最多取幾篇最新的文章（避免單一來源佔滿，也控制 token 用量） */
export const PER_SOURCE_CAP: Record<Region, number> = { tw: 30, world: 12 };

/**
 * 來源選擇原則：通訊社與公共媒體優先；國際部分刻意混合不同國家的公共或國際媒體，
 * 讓「同一事件被多家報導」可以互相印證。
 *
 * 注意：沒有任何媒體絕對中立。想增減來源，直接改這個陣列即可。
 * 單一 feed 失效不會影響其他來源，狀況會記錄在每份摘要的 sources 欄位。
 */
export const FEEDS: Feed[] = [
  // ── 台灣 ─────────────────────────────────────────
  // 中央社（國家通訊社）
  { region: "tw", name: "中央社", url: "https://feeds.feedburner.com/rsscna/politics" },
  { region: "tw", name: "中央社", url: "https://feeds.feedburner.com/rsscna/social" },
  { region: "tw", name: "中央社", url: "https://feeds.feedburner.com/rsscna/finance" },
  { region: "tw", name: "中央社", url: "https://feeds.feedburner.com/rsscna/mainland" },
  { region: "tw", name: "中央社", url: "https://feeds.feedburner.com/rsscna/local" },
  // 公視新聞網（公共電視）
  { region: "tw", name: "公視新聞網", url: "https://news.pts.org.tw/xml/newsfeed.xml" },
  // 其他可選來源（預設不開，因為立場或定位不同，請自行判斷）：
  // { region: "tw", name: "自由時報", url: "https://news.ltn.com.tw/rss/all.xml" },

  // ── 世界 ─────────────────────────────────────────
  { region: "world", name: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { region: "world", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { region: "world", name: "DW", url: "https://rss.dw.com/rdf/rss-en-all" },
  { region: "world", name: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  // region: "world", name: "France 24", url: "https://www.france24.com/en/top-stories/rss" },
  { region: "world", name: "中央社（國際）", url: "https://feeds.feedburner.com/rsscna/intworld" },
];
