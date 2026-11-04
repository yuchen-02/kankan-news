import type { Env, Summarizer } from "../types.ts";
import { claudeSummarizer } from "./claude.ts";
import { workersAiSummarizer } from "./workersai.ts";

export interface ChosenSummarizer {
  name: string;
  model: string;
  run: Summarizer;
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
