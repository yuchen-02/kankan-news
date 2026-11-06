import { CATEGORIES, MAX_CATEGORIES } from "../categories.ts";
import type { SummarizeInput } from "../types.ts";

/** 台北時間 "MM-DD HH:mm"（固定 UTC+8，不受 Worker 執行環境時區影響） */
function taipei(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

export function buildSystemPrompt(input: SummarizeInput): string {
  const isTw = input.region === "tw";
  const scope = isTw ? "台灣" : "國際";
  return `你是新聞摘要編輯，負責把一段時間內多家媒體的報導，整理成中立的重點摘要。這次的範圍是${scope}新聞。
輸出語言：繁體中文（台灣慣用詞彙）。英文來源請翻譯成中文。

寫作規則：
1. 只能使用我提供的標題與摘要裡有的資訊。不推測原因、不補充背景、不預測後續；不確定就不寫。
2. 用平實、中性的語氣。不使用情緒或評價字眼（例如「震驚」「痛批」「慘」「狂」「竟」），不下結論、不做評論。
3. 有人主張或指控時，要寫明是誰說的（例如「某某表示……」），不可把單方說法寫成既定事實。數字、日期、人名照原文。
4. 同一事件的多篇報導合併成一則，articleIds 列出所有相關的文章編號。每篇文章只能出現在一則裡：一篇報導即使提到好幾件事，也只當成一則，標題與摘要以它最主要的那件事為準，不要拆成多則。
5. 如果不同來源對同一事件的描述有明顯差異，在 disputed 用一句話說明差異；沒有差異就填 null。
6. 依重要性排序（影響範圍、公共政策、安全、經濟）。除非有重大公共意義，略過娛樂、體育比分、八卦與促銷內容。
7. 最多 ${input.maxEvents} 則，寧缺勿濫。
8. articleIds 只能使用我給的編號。
9. categories 是這則新聞的類型標籤，只能從這個清單選：${CATEGORIES.join("、")}。符合多個類型就列出多個（最多 ${MAX_CATEGORIES} 個，最貼切的放前面）；不要自己發明清單以外的類型。${isTw ? `
10. foreign 判斷這則新聞屬不屬於「國外新聞」：事件發生在國外、主角也不是台灣的政府、企業或人民，台灣只是被引述或附帶提到，填 true（例如外國的選舉結果、外國的社會事件、外國的戰爭與災難）。事件發生在台灣，或台灣的政府、企業、民眾是主角或直接當事方（例如台灣官方對國外事件的回應、國外事件對台灣的具體影響、兩岸與台灣參與的國際會議），填 false。` : ""}

只輸出一個 JSON 物件，不要任何其他文字，格式如下：
{"events":[{"headline":"不超過 30 字的中性標題","summary":"1 到 3 句，不超過 120 字","disputed":null,"articleIds":[1,2],"categories":["政治","經濟"]${isTw ? ',"foreign":false' : ""}}]}`;
}

export function buildUserPrompt(input: SummarizeInput): string {
  // 文章很多時把內文摘錄縮短，控制輸入長度（模型的上下文有限）
  const snippetLen = input.articles.length > 80 ? 100 : 160;
  const lines = input.articles.map((a) => {
    const head = `[${a.id}] ${a.source}｜${taipei(a.publishedAt)}｜${a.title}`;
    return a.snippet ? `${head}\n${a.snippet.slice(0, snippetLen)}` : head;
  });
  return `時間範圍：${taipei(input.windowStart)} 到 ${taipei(input.windowEnd)}（台北時間）
共 ${input.articles.length} 篇文章：

${lines.join("\n\n")}`;
}
