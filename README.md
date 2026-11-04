# 看看新聞

把台灣跟世界的重要新聞，每天早、中、晚各整理一次的個人小網站。

## 簡介

我常常覺得不知道世界上發生了什麽，所以做了這個網站幫我抓新聞：一天三次（台北時間 07:00、12:00、18:00）自動讀取各家媒體的公開RSS，請AI整理成幾則重點。每則新聞有類型標籤、縮圖、來源連結，點一下就跳到原文。

設計上盡量降低偏見：來源以通訊社與公共媒體為主、摘要只能用來源裡有的資訊、不用評價字眼、由程式帶入來源連結。

## 功能

- 每天三次自動產生摘要，歷史可從日曆按鈕切換
- 台灣/世界分頁：每則新聞有類型標籤、縮圖，可點擊卡片到第一個新聞來源
- 顯示時間（台北時間）、現在的溫度、濕度、降雨機率，預設台北，可改用目前位置
- 亮暗色模式

## 使用技術

- **平台**：Cloudflare Workers（排程：Cron Triggers、儲存：KV、靜態資源託管）
- **AI 摘要**：Workers AI（Llama 3.3 70B）
- **後端**：TypeScript；RSS/Atom
- **前端**：原生HTML/CSS/JavaScript（ES modules）
- **測試**：Node 內建 node:test
- **外部服務**：天氣：Open-Meteo、地名：BigDataCloud、國旗：flagcdn、字體：Google Fonts

## 資料來源

- 台灣：中央社、公視新聞網
- 世界：BBC、Al Jazeera、DW、NPR、中央社（國際）

新聞標題與縮圖版權屬於各媒體，本站只引用公開的 RSS 內容並附上原文連結，不做商業用途。

## 專案結構

```
src/            Worker：抓取 RSS、整理、摘要、存進 KV、API
  summarizers/  可替換的摘要函式（Workers AI／Claude）
public/         前端頁面與圖片
test/           單元測試
wrangler.example.jsonc   設定範本（實際的 wrangler.jsonc 不放進 repo）
```
