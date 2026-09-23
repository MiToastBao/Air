/*
 * Excel 讀寫（ExcelJS）— 把活頁簿轉成解析器要的二維陣列，並寫出報表。
 */
(function (root) {
  'use strict';
  var Core = root.EnvCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  function cellValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) return cellValue(v.result);          // 公式
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
      if ('text' in v) return v.text;                           // 超連結
      if ('error' in v) return null;                            // #N/A 等
      return null;
    }
    return v;
  }

  function workbookToSheets(wb) {
    var out = [];
    wb.worksheets.forEach(function (ws) {
      if (ws.state && ws.state !== 'visible') return; // 隱藏工作表不讀
      var rows = [];
      ws.eachRow({ includeEmpty: true }, function (row, rn) {
        var arr = [];
        var vals = row.values; // 1-based
        for (var c = 1; c < vals.length; c++) arr.push(cellValue(vals[c]));
        rows[rn - 1] = arr;
      });
      for (var i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      out.push({ name: ws.name, rows: rows });
    });
    return out;
  }

  function hiddenSheetNames(wb) {
    return wb.worksheets.filter(function (ws) { return ws.state && ws.state !== 'visible'; }).map(function (ws) { return ws.name; });
  }

  // 日期存成 Excel 日期（UTC 牆上時間）
  function dateCell(d) {
    var p = d.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function styleSheet(ws, widths) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    widths.forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    var h = ws.getRow(1);
    h.font = { bold: true };
    h.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    h.eachCell(function (c) { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
  }

  /** 空氣品質日均報表；includeRain 決定是否加雨量欄 */
  function buildAirWorkbook(ExcelJS, rows, opts) {
    opts = opts || {};
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('空氣品質日均');
    var head = ['感測器編號', '感測器名稱', '日期', 'TMP平均', 'HUM平均', 'PM10平均', 'PM25平均', 'TVOC平均', 'WS平均', '最頻風向'];
    if (opts.includeRain) head.push('日累積雨量(mm)');
    head.push('備註');
    ws.addRow(head);
    rows.forEach(function (r) {
      var line = [r.id, r.name, dateCell(r.date), r.TMP, r.HUM, r.PM10, r.PM25, r.TVOC, r.WS, r.WD];
      if (opts.includeRain) line.push(r.RA);
      line.push(r.note);
      ws.addRow(line);
    });
    ws.getColumn(3).numFmt = 'yyyy/mm/dd';
    for (var c = 4; c <= 9; c++) ws.getColumn(c).numFmt = '0.0';
    if (opts.includeRain) ws.getColumn(11).numFmt = '0.0';
    var widths = [12, 16, 12, 9, 9, 9, 9, 9, 9, 14];
    if (opts.includeRain) widths.push(12);
    widths.push(40);
    styleSheet(ws, widths);
    return wb;
  }

  function buildNoiseWorkbook(ExcelJS, rows) {
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('噪音Leq日晚夜');
    ws.addRow(['感測器編號', '感測器名稱', '日期', 'Leq日', 'Leq晚', 'Leq夜', '備註']);
    rows.forEach(function (r) { ws.addRow([r.id, r.name, dateCell(r.date), r.DAY, r.EVE, r.NIGHT, r.note]); });
    ws.getColumn(3).numFmt = 'yyyy/mm/dd';
    for (var c = 4; c <= 6; c++) ws.getColumn(c).numFmt = '0.0';
    styleSheet(ws, [12, 16, 12, 9, 9, 9, 44]);
    return wb;
  }

  var api = {
    workbookToSheets: workbookToSheets, hiddenSheetNames: hiddenSheetNames,
    buildAirWorkbook: buildAirWorkbook, buildNoiseWorkbook: buildNoiseWorkbook, cellValue: cellValue
  };
  root.EnvXlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
