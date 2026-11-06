/**
 * 訪客計數的防灌水：同一個來源（IP）在視窗時間內只算一次。
 * 只存在 Durable Object 的記憶體裡，不寫入儲存空間；物件被回收時自然清空，不會留下任何 IP。
 */
export const VISIT_WINDOW_MS = 10_000;
const MAX_TRACKED = 2000;

export function allowHit(recent: Map<string, number>, key: string, now: number, windowMs = VISIT_WINDOW_MS): boolean {
  // 順手清掉過期的，避免 Map 無限長大
  if (recent.size > MAX_TRACKED) {
    for (const [k, t] of recent) if (now - t >= windowMs) recent.delete(k);
    if (recent.size > MAX_TRACKED) recent.clear();
  }
  const last = recent.get(key);
  if (last !== undefined && now - last < windowMs) return false;
  recent.set(key, now);
  return true;
}
