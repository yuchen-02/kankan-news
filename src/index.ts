import { handleRequest } from "./api.ts";
import { runScheduled } from "./pipeline.ts";
export { VisitCounter } from "./counter.ts";
export { StockHub } from "./stocks/hub.ts";
import { runCloseJob } from "./stocks/store.ts";
import type { Env } from "./types.ts";

/** 抓收盤價的排程（UTC 06:30、06:40 = 台北 14:30、14:40，週一到週五）；要和 wrangler.jsonc 裡的寫法一模一樣。
 *  （Worker 的主檔只能 export 處理函式與 Durable Object 類別，所以這裡不 export） */
const STOCK_CRON = "30,40 6 * * 1-5";

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === STOCK_CRON) {
      // 14:40 那次是最後機會：再失敗就標記失敗
      const retry = new Date(event.scheduledTime).getUTCMinutes() === 40;
      ctx.waitUntil(
        runCloseJob(env, { now: event.scheduledTime, retry }).then(
          (r) => console.log("stocks:", r.message),
          (e) => {
            console.error(e instanceof Error ? e.message : e);
            throw e;
          },
        ),
      );
      return;
    }
    ctx.waitUntil(
      runScheduled(env, event.scheduledTime).then(
        (msg) => console.log(msg),
        (e) => {
          console.error("digest failed:", e instanceof Error ? e.message : e);
          throw e;
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
