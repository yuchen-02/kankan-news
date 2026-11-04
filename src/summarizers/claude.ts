import type { Env, RawEvent, SummarizeInput, Summarizer } from "../types.ts";
import { parseEvents } from "./json.ts";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

export function claudeSummarizer(env: Env): { model: string; run: Summarizer } {
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;

  const run = async (input: SummarizeInput): Promise<RawEvent[]> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("SUMMARIZER=claude，但沒有設定 ANTHROPIC_API_KEY（npx wrangler secret put ANTHROPIC_API_KEY）");
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        temperature: 0.2,
        system: buildSystemPrompt(input),
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      // 只回報狀態碼與前 200 字，避免把整包回應（或任何敏感內容）寫進紀錄
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Claude API 回應 ${res.status}：${body}`);
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return parseEvents(text, input.articles.length);
  };

  return { model, run };
}
