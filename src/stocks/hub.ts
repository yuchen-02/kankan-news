import { DurableObject } from "cloudflare:workers";
import {
  LIVE_STALE_AFTER,
  buildLive,
  diffQuotes,
  isMarketHours,
  liveBackoffMs,
  livePlan,
  liveSlotsFull,
  parseViewMessage,
  taipeiTime,
  type IndexQuote,
  type IntradayChart,
  type LiveQuote,
} from "./market.ts";
import { fetchIntraday, fetchLive, fetchMisBatches, getUniverse } from "./store.ts";
import type { Env } from "../types.ts";

/** 盤中每 5 秒抓一次；收盤後（還在看最後成交價的人）每分鐘一次就夠了，資料不會再變 */
export const LIVE_INTERVAL_MS = 5_000;
const IDLE_INTERVAL_MS = 60_000;

/** 推送給頁面的狀態：live＝盤中、after＝已收盤（最後成交價）、holiday＝今天休市、stale＝暫時抓不到（畫面上是之前的資料） */
export type LiveStatus = "live" | "after" | "holiday" | "stale";

export interface LiveMessage {
  /** full＝完整資料（剛連上時）、delta＝只有變動的股票 */
  type: "full" | "delta" | "status";
  status: LiveStatus;
  /** 資料日期 YYYY-MM-DD */
  date?: string | null;
  /** 證交所資料時間 HH:MM:SS */
  time?: string | null;
  /** 伺服器抓到的時間（ISO） */
  at?: string;
  index?: IndexQuote | null;
  quotes?: LiveQuote[];
}

/** 連線的標籤：用來算同一個 IP 有幾條連線。存的是雜湊，連線斷了就消失 */
async function ipTag(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Latest {
  at: number;
  status: LiveStatus;
  date: string | null;
  time: string | null;
  index: IndexQuote | null;
  map: Map<string, LiveQuote>;
}

/**
 * 盤中價格的推送中心（全站只有一個實例，名稱固定為 "tw"）。
 *
 * - 有人打開台股頁面（而且正在看）時，頁面會用 WebSocket 連進來；建立連線算 1 次請求，之後的推送不算請求次數。
 * - 只要還有人連著，就用 alarm 每 5 秒向證交所抓 2 批：大家正在看的股票＋指數、其他股票輪流一批，再推送給所有人。
 *   證交所會擋太頻繁的請求（每 5 秒抓全部 10 批時幾乎全被拒絕），所以只有剛開始或盤後才一次抓全部。
 *   不管 1 個人還是 100 個人在看，抓的次數都一樣。
 * - 頁面捲動時用 {"type":"view","codes":[...]} 告訴這裡正在看哪些股票，記在各連線的 attachment（休眠後還在）。
 * - 沒有人連著時，alarm 就不再排下一次，完全不抓。
 * - 用 WebSocket Hibernation API：等待下一次 alarm 時可以休眠，不佔運作時間。
 */
export class StockHub extends DurableObject<Env> {
  private latest: Latest | null = null;
  private codes: string[] | null = null;
  private failures = 0;
  /** 輪流抓到第幾檔 */
  private cursor = 0;
  /** 加權指數當日走勢（全站共用，盤中最多每分鐘向證交所抓一次） */
  private chart: { at: number; data: IntradayChart | null } | null = null;
  private chartLoading: Promise<IntradayChart | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 頁面送 "ping" 保持連線時，直接由系統回 "pong"，不用喚醒物件
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("需要 WebSocket", { status: 426 });
    }
    const tag = await ipTag(request.headers.get("cf-connecting-ip") ?? "unknown");
    if (liveSlotsFull(this.ctx.getWebSockets().length, this.ctx.getWebSockets(tag).length)) {
      return new Response("連線數已滿", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [tag]);

    if (this.latest) server.send(JSON.stringify(this.fullMessage(this.latest)));
    // 已經排好下一次就不動（連續失敗時的等待不會被新連線打斷）；手上沒有資料（剛啟動或休眠醒來）就馬上抓一次
    if ((await this.ctx.storage.getAlarm()) === null) {
      const now = Date.now();
      await this.ctx.storage.setAlarm(this.latest ? now + this.intervalFor(now) : now);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      // 沒有人在看：不排下一次，也不留資料
      this.latest = null;
      this.failures = 0;
      return;
    }
    const start = Date.now();
    const interval = this.intervalFor(start);

    // 收盤後資料不會再變，一分鐘內抓過就不重抓
    if (!isMarketHours(start) && this.latest && start - this.latest.at < IDLE_INTERVAL_MS) {
      await this.ctx.storage.setAlarm(this.latest.at + IDLE_INTERVAL_MS);
      return;
    }

    try {
      if (!this.codes) this.codes = (await getUniverse(this.env.NEWS)).map(([c]) => c);
      const prevPrices = this.latest ? new Map([...this.latest.map].map(([k, q]) => [k, q[1]])) : undefined;
      // 剛開始（手上沒資料）或盤後：一次抓全部；盤中：只抓正在看的＋輪流一批
      const partial = !!this.latest && isMarketHours(start);
      let snap;
      if (partial) {
        const plan = livePlan(this.codes, this.visibleCodes(), this.cursor);
        snap = buildLive(await fetchMisBatches(plan.batches), prevPrices);
        this.cursor = plan.nextCursor;
      } else {
        snap = await fetchLive(this.codes, prevPrices);
      }
      const today = taipeiTime(start).date;
      const status: LiveStatus = snap.date && snap.date !== today ? "holiday" : isMarketHours(start) ? "live" : "after";
      const next: Latest = {
        at: start,
        status,
        date: snap.date,
        time: snap.time,
        index: snap.index,
        // 只抓了一部分時，沒抓到的股票沿用上一次的價格
        map: new Map([...(partial && this.latest ? this.latest.map : []), ...snap.quotes.map((q): [string, LiveQuote] => [q[0], q])]),
      };
      const prev = this.latest;
      const msg: LiveMessage =
        prev && prev.date === next.date
          ? { type: "delta", status, date: next.date, time: next.time, at: new Date(start).toISOString(), index: next.index, quotes: diffQuotes(prev.map, snap.quotes) }
          : this.fullMessage(next);
      this.latest = next;
      this.failures = 0;
      this.broadcast(JSON.stringify(msg));
      await this.ctx.storage.setAlarm(start + (status === "holiday" ? IDLE_INTERVAL_MS : interval));
    } catch (e) {
      this.failures += 1;
      console.error("stock live fetch failed:", e instanceof Error ? e.message : String(e));
      if (this.failures >= LIVE_STALE_AFTER) this.broadcast(JSON.stringify({ type: "status", status: "stale" } satisfies LiveMessage));
      // 連續失敗就拉長間隔（可能被證交所暫時擋下）
      await this.ctx.storage.setAlarm(Date.now() + liveBackoffMs(interval, this.failures));
    }
  }

  /** 加權指數當日走勢（給 /api/stocks/intraday 用）。盤中 1 分鐘、其他時候 10 分鐘內不重抓；抓失敗也一樣等，不連續打證交所 */
  async intraday(): Promise<IntradayChart | null> {
    const now = Date.now();
    const ttl = isMarketHours(now) ? 60_000 : 10 * 60_000;
    if (this.chart && now - this.chart.at < ttl) return this.chart.data;
    this.chartLoading ??= fetchIntraday()
      .catch((e) => {
        console.error("intraday chart:", e instanceof Error ? e.message : String(e));
        return this.chart?.data ?? null;
      })
      .then((data) => {
        this.chart = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.chartLoading = null;
      });
    return this.chartLoading;
  }

  /** 頁面回報正在看哪些股票 */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.codes) this.codes = (await getUniverse(this.env.NEWS)).map(([c]) => c);
    const codes = parseViewMessage(message, new Set(this.codes));
    if (codes) ws.serializeAttachment({ codes });
  }

  /** 所有連線正在看的股票（聯集） */
  private visibleCodes(): string[] {
    const out = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { codes?: string[] } | null;
      for (const c of a?.codes ?? []) out.add(c);
    }
    return [...out];
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* 已經關掉了 */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* 已經關掉了 */
    }
  }

  private intervalFor(now: number): number {
    return isMarketHours(now) ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
  }

  private fullMessage(l: Latest): LiveMessage {
    return { type: "full", status: l.status, date: l.date, time: l.time, at: new Date(l.at).toISOString(), index: l.index, quotes: [...l.map.values()] };
  }

  private broadcast(text: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* 這個連線已經斷了，下一次 alarm 時就不會再出現 */
      }
    }
  }
}
