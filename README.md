# 微型感測器數據系統

（原本暫稱「環境監測季報產生器」，v1.12.3 起改名。）

匯入每月「數據月報」（.xlsx），選擇季別、月份區間、自訂日期或全部累積，下載：

- 空氣品質日均報表（TMP、HUM、PM10、PM2.5、TVOC、WS 日平均、最頻風向、日累積雨量、備註）
- 噪音 Leq 日晚夜報表（能量平均、備註）
- 盒鬚圖（⑧）、環境部比對趨勢圖（⑨）：高解析度圖片與可編輯 Excel

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
| `js/boxplot.js`、`js/boxstyle.js` | ⑧ 盒鬚圖（統計、圖片、Excel 盒鬚圖） |
| `js/trend.js` | ⑨ 環境部比對趨勢圖（環境部資料匯入／自動抓取、趨勢圖、Excel 折線圖）；**環境部網址與金鑰在這裡** |
| `js/version.js` | 版本號與版本紀錄 |
| `vendor/exceljs.min.js` | ExcelJS 4.4.0（MIT，授權見 `vendor/exceljs-LICENSE.txt`） |
| `vendor/jszip.min.js` | JSZip 3.10.1（MIT，授權見 `vendor/jszip-LICENSE.md`） |
| `tests/` | 守門測試（只用人造資料），執行：`node --test tests/unit.test.js` |

## 給維護者（含 AI）：常見維護事項

### 環境部測站資料抓不到（⑨ 環境部比對趨勢圖）

- 網址與金鑰寫在 **`js/trend.js`**：`DEFAULT_API`（各測站小時值）、`STATIONS_API`（測站清單，資料集 AQX_P_07）、`DEFAULT_KEY`（畫面上沒有設定欄位，刻意由維護者修改）。
- 各測站一個資料集「空氣品質小時值_縣市_站名」，代碼＝`aqx_p_`（188＋測站編號），例：彰化站編號 33 → AQX_P_221（https://data.moenv.gov.tw/dataset/detail/AQX_P_221）。不符合規則的測站寫在 `DATASET_OVERRIDE`（`{測站編號: '資料集代碼'}`）；抓到的測站對不上時畫面會提示。
- `DEFAULT_API` 的 `{dataset}`、`{key}`、`{from}`、`{to}`、`{offset}` 由程式代入（月初 `2026-04-01 00:00`、下個月初、翻頁位置，每頁 1000 筆）。回傳必須是 JSON 陣列，欄位含 `siteid`、`sitename`、`itemengname`、`monitordate`、`concentration`（不分大小寫）；解析在 `parseMoenvJson`／`fromRecords`。
- 資料存在 IndexedDB 的 meta：`moe|測站編號|YYYY-MM`（原始字串，含 x 等無效標記）、`moeSites`（圖例名稱）、`moeStations`（測站清單快取）。v1.12 以前的 `moenv`（只有彰化站 PM10、PM2.5）開啟 ⑨ 時自動轉換（`migrateLegacy`）。
- `DEFAULT_KEY` 是環境部「透過API下載歷史資料操作手冊」裡的範例金鑰；若被停用，請使用者到平臺註冊會員取得自己的金鑰後替換。
- 瀏覽器端直接呼叫（2026-09 實測 CORS 可用）；金鑰錯誤時瀏覽器只回報「Failed to fetch」。短時間大量請求會被環境部暫時擋下。
- 修改後請跑 `node --test tests/unit.test.js`，並更新 `js/version.js`、`CHANGELOG.md`、`index.html` 的 `?v=` 版本參數。
- 抓不到時使用者可改用「自行匯入環境部 CSV 檔」，格式相同（`parseMoenvCsv`）。

### 其他

- 版本號：`js/version.js`（`ENV_APP_VERSION` 與 `ENV_VERSION_HISTORY`），每次發布都要把 `index.html` 內所有 `?v=` 一起改，避免瀏覽器快取舊檔。
- 計算口徑的詳細說明在 `使用說明.html`；改計算方式時兩邊要一起改，並補守門測試。
- 不要把真實監測資料放進 repository（測試只用人造資料）。

## 發布（GitHub Pages）

Settings → Pages → Build and deployment → Source 選「Deploy from a branch」，Branch 選 `main`、資料夾 `/ (root)`。
