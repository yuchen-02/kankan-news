import type { Env, RawEvent, SummarizeInput, Summarizer } from "../types.ts";
import { parseEvents } from "./json.ts";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

/** 呼叫一次模型，回傳純文字 */
export async function claudeText(env: Env, system: string, user: string, maxTokens: number): Promise<string> {
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
      model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    // 只回報狀態碼與前 200 字，避免把整包回應（或任何敏感內容）寫進紀錄
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Claude API 回應 ${res.status}：${body}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export function claudeSummarizer(env: Env): { model: string; run: Summarizer } {
  const model = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;

  const run = async (input: SummarizeInput): Promise<RawEvent[]> => {
    const text = await claudeText(env, buildSystemPrompt(input), buildUserPrompt(input), 3000);
    return parseEvents(text, input.articles.length);
  };

  return { model, run };
}
