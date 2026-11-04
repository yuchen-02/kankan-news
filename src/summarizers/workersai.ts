import type { Env, RawEvent, SummarizeInput, Summarizer } from "../types.ts";
import { parseEvents } from "./json.ts";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.ts";

export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type AiBinding = { run(model: string, input: unknown): Promise<unknown> };

/** 不同模型的回傳格式不太一樣，這裡統一抽出文字 */
function extractText(res: unknown): string {
  if (typeof res === "string") return res;
  const r = res as Record<string, any> | null;
  if (!r) return "";
  if (typeof r.response === "string") return r.response;
  if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
  const content = r.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (typeof r.result?.response === "string") return r.result.response;
  return "";
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 逾時（${ms / 1000} 秒）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function workersAiSummarizer(env: Env): { model: string; run: Summarizer } {
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const ai = env.AI as unknown as AiBinding;

  const run = async (input: SummarizeInput): Promise<RawEvent[]> => {
    const system = buildSystemPrompt(input);
    const user = buildUserPrompt(input);
    let lastError: unknown;

    // 小模型偶爾會吐出壞掉的 JSON，所以最多試兩次
    for (let attempt = 0; attempt < 2; attempt++) {
      const retryNote = attempt === 0 ? "" : "\n\n注意：上一次的輸出不是合法的 JSON。請只輸出一個 JSON 物件，不要任何其他文字。";
      try {
        const res = await withTimeout(
          ai.run(model, {
            messages: [
              { role: "system", content: system },
              { role: "user", content: user + retryNote },
            ],
            // Workers AI 預設 max_tokens 很小（256），一定要明確設定
            max_tokens: 3000,
            temperature: 0.2,
          }),
          150_000,
          "Workers AI",
        );
        return parseEvents(extractText(res), input.articles.length);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  return { model, run };
}
