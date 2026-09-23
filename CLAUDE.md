# 微型感測器數據系統：給 AI 維護者的說明

請先讀 `README.md` 的「給維護者（含 AI）：常見維護事項」。

- 環境部測站資料（⑨ 分頁自動抓取）抓不到、環境部網址變更或金鑰失效：修改 `js/trend.js` 的 `DEFAULT_API`、`DEFAULT_KEY`（資料集 AQX_P_221，https://data.moenv.gov.tw/dataset/detail/AQX_P_221）。
- 每次修改：跑 `node --test tests/unit.test.js`；更新 `js/version.js`、`CHANGELOG.md`、`使用說明.html` 頁尾，以及 `index.html` 所有 `?v=` 參數。
- 使用者是中文使用者；不要把真實監測資料放進 repository。
