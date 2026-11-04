import { normalizeCategories } from "../categories.ts";
import type { RawEvent } from "../types.ts";

/** 從模型輸出中找出 JSON 物件（容忍 ```json 圍欄、前後多餘文字） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("模型輸出中找不到 JSON 物件");
  return JSON.parse(body.slice(start, end + 1));
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * 驗證並整理模型輸出：
 * - 丟掉沒有標題、沒有摘要、或沒有任何有效文章編號的事件（防止模型捏造）
 * - 文章編號只保留 1..maxId 的整數並去重
 */
export function parseEvents(text: string, maxId: number): RawEvent[] {
  const data = extractJson(text) as { events?: unknown };
  if (!data || !Array.isArray(data.events)) throw new Error("JSON 裡沒有 events 陣列");

  const out: RawEvent[] = [];
  for (const e of data.events as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const headline = str(e.headline, 80);
    const summary = str(e.summary, 400);
    const ids = Array.isArray(e.articleIds) ? e.articleIds : [];
    const articleIds = [
      ...new Set(
        ids
          .map((n) => (typeof n === "number" ? n : Number(n)))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= maxId),
      ),
    ];
    if (!headline || !summary || articleIds.length === 0) continue;

    const disputedRaw = str(e.disputed, 300);
    const disputed = disputedRaw && !/^(null|無|沒有|none)$/i.test(disputedRaw) ? disputedRaw : null;
    const categories = normalizeCategories(e.categories);
    out.push({ headline, summary, disputed, articleIds, ...(categories.length ? { categories } : {}) });
  }
  return out;
}
