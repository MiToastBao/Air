(function (root) {
  root.ENV_APP_VERSION = 'v1.1.0';
  root.ENV_VERSION_HISTORY = [
    { v: 'v1.1.0', date: '2026-09-23', note: '備註時段確認加入批次處理：月報備註篩選（可全選、關鍵字）、表頭全選、指定測項一次設為不採用／改回採用。計算方式不變。' },
    { v: 'v1.0.0', date: '2026-09-23', note: '第一版：由 Access 資料庫移植。匯入月報、季別／區間報表、雨量、有效時數備註、備份還原、備註時段確認（紅框提醒、逐格或批次勾選不採用後重新計算）。' }
  ];
})(typeof globalThis !== 'undefined' ? globalThis : this);
