import { DurableObject } from "cloudflare:workers";
import { allowHit } from "./visits.ts";

/**
 * 全站只有一個實例（名稱固定為 "global"），所有請求都會排隊進來，
 * 所以「讀出、加一、寫回」不會像 KV 那樣在同時進來時漏算。
 */
export class VisitCounter extends DurableObject {
  private recent = new Map<string, number>();

  /** 加一並回傳目前總數；同一個來源太快重複送出時不加，只回傳目前總數 */
  async hit(key: string): Promise<number> {
    let n = (await this.ctx.storage.get<number>("count")) ?? 0;
    if (allowHit(this.recent, key, Date.now())) {
      n += 1;
      await this.ctx.storage.put("count", n);
    }
    return n;
  }

  async get(): Promise<number> {
    return (await this.ctx.storage.get<number>("count")) ?? 0;
  }
}
