import type { Env, Summarizer } from "../types.ts";
import { DEFAULT_CLAUDE_MODEL, claudeSummarizer, claudeText } from "./claude.ts";
import { DEFAULT_AI_MODEL, workersAiSummarizer, workersAiText } from "./workersai.ts";

export interface ChosenSummarizer {
  name: string;
  model: string;
  run: Summarizer;
}

export interface TextModel {
  model: string;
  text(system: string, user: string, maxTokens: number): Promise<string>;
}

/** 和摘要用同一個模型設定，但回傳純文字（給收盤分析用） */
export function pickTextModel(env: Env): TextModel {
  return (env.SUMMARIZER || "workers-ai").toLowerCase() === "claude"
    ? { model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL, text: (s, u, n) => claudeText(env, s, u, n) }
    : { model: env.AI_MODEL || DEFAULT_AI_MODEL, text: (s, u, n) => workersAiText(env, s, u, n) };
}

/**
 * 摘要函式的切換點。
 * 要換成別的服務：在這個資料夾新增一個回傳 { model, run } 的檔案，
 * 然後在下面加一個 case 即可，其餘流程完全不用動。
 */
export function pickSummarizer(env: Env): ChosenSummarizer {
  const name = (env.SUMMARIZER || "workers-ai").toLowerCase();
  switch (name) {
    case "claude":
      return { name, ...claudeSummarizer(env) };
    case "workers-ai":
      return { name, ...workersAiSummarizer(env) };
    default:
      throw new Error(`未知的 SUMMARIZER：${name}（可用值：workers-ai、claude）`);
  }
}
