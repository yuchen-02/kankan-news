/** 新聞類型標籤的固定清單。模型只能從這裡選；不在清單內的會被丟掉，避免出現雜亂的標籤。 */
export const CATEGORIES = [
  "政治", "外交", "軍事", "經濟", "社會", "犯罪", "司法", "科技",
  "健康", "環境", "災害", "教育", "交通", "能源", "文化", "體育",
] as const;

export const MAX_CATEGORIES = 3;

/** 驗證模型給的類型：只留清單內的、去重、最多 3 個；沒有有效的就回傳空陣列 */
export function normalizeCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const allowed = new Set<string>(CATEGORIES);
  const out: string[] = [];
  for (const x of v) {
    const c = typeof x === "string" ? x.trim() : "";
    if (allowed.has(c) && !out.includes(c)) out.push(c);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}
