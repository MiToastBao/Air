# 環境監測季報產生器

匯入每月「數據月報」（.xlsx），選擇季別、月份區間、自訂日期或全部累積，下載：

- 空氣品質日均報表（TMP、HUM、PM10、PM2.5、TVOC、WS 日平均、最頻風向、日累積雨量、備註）
- 噪音 Leq 日晚夜報表（能量平均、備註）

純靜態網頁，可直接用 GitHub Pages 發布，不需要建置步驟。

## 資料隱私

所有計算都在使用者的瀏覽器裡完成，匯入的資料存在瀏覽器的 IndexedDB，**不會上傳**到 GitHub 或任何伺服器。
請勿把真實監測資料（月報、報表、備份檔）放進這個 repository。

## 檔案

| 路徑 | 用途 |
|---|---|
| `index.html` | 主畫面 |
| `使用說明.html` | 新手使用說明（計算方式詳解） |
| `js/core.js` | 計算核心（日平均、最頻風向、噪音日晚夜、雨量、備註） |
| `js/parser.js` | 月報解析（依內容判讀欄位） |
| `js/model.js` | 匯入比對（新增／覆蓋）與資料整理 |
| `js/xlsxio.js` | Excel 讀寫 |
| `js/store.js` | 瀏覽器儲存 |
| `js/app.js` | 畫面流程 |
| `js/version.js` | 版本號與版本紀錄 |
| `vendor/exceljs.min.js` | ExcelJS 4.4.0（MIT，授權見 `vendor/exceljs-LICENSE.txt`） |
| `tests/` | 守門測試（只用人造資料），執行：`node --test tests/unit.test.js` |

## 發布（GitHub Pages）

Settings → Pages → Build and deployment → Source 選「Deploy from a branch」，Branch 選 `main`、資料夾 `/ (root)`。
