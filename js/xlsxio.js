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

  var NA = '－'; // 有這個測項、但當日沒有有效數值（異常值、空白、不採用、當日無資料）
  /** 有這個測項但沒有數值 → 「－」；這台根本沒有這個測項 → 留白 */
  function cellOr(r, f, v) {
    if (v !== null && v !== undefined && v !== '') return v;
    if (!r.fields || r.fields.indexOf(f) >= 0) return NA;
    return null;
  }
  function centerNA(ws, fromCol, toCol) {
    ws.eachRow(function (row, rn) {
      if (rn === 1) return;
      for (var c = fromCol; c <= toCol; c++) { var cell = row.getCell(c); if (cell.value === NA || cell.value === '<0.3') cell.alignment = { horizontal: 'center' }; }
    });
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
      var line = [r.id, r.name, dateCell(r.date)].concat(['TMP', 'HUM', 'PM10', 'PM25', 'TVOC', 'WS', 'WD'].map(function (f) { return cellOr(r, f, r[f]); }));
      if (opts.includeRain) line.push(cellOr(r, 'RA', r.RA));
      line.push(r.note);
      ws.addRow(line);
    });
    ws.getColumn(3).numFmt = 'yyyy/mm/dd';
    for (var c = 4; c <= 9; c++) ws.getColumn(c).numFmt = '0.0';
    if (opts.includeRain) ws.getColumn(11).numFmt = '0.0';
    // 超過空氣品質標準的日平均：粗體＋底線（直接設定在儲存格上，複製貼到報告也會保留）
    var std = opts.std || {};
    var over = 0;
    rows.forEach(function (r, i) {
      var row = ws.getRow(i + 2);
      [['PM10', 6], ['PM25', 7]].forEach(function (x) {
        var lim = std[x[0]];
        if (typeof lim === 'number' && isFinite(lim) && typeof r[x[0]] === 'number' && r[x[0]] > lim) {
          row.getCell(x[1]).font = { bold: true, underline: true };
          over++;
        }
      });
    });
    wb.overCount = over;
    centerNA(ws, 4, opts.includeRain ? 11 : 10);
    var widths = [12, 16, 12, 9, 9, 9, 9, 9, 9, 14];
    if (opts.includeRain) widths.push(12);
    widths.push(40);
    styleSheet(ws, widths);
    return wb;
  }

  function buildNoiseWorkbook(ExcelJS, rows, opts) {
    opts = opts || {};
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('噪音Leq日晚夜');
    ws.addRow(['感測器編號', '感測器名稱', '日期', 'Leq日', 'Leq晚', 'Leq夜', '備註']);
    rows.forEach(function (r) { ws.addRow([r.id, r.name, dateCell(r.date), cellOr(r, 'LEQ', r.DAY), cellOr(r, 'LEQ', r.EVE), cellOr(r, 'LEQ', r.NIGHT), r.note]); });
    centerNA(ws, 4, 6);
    // 超過噪音管制標準（嚴格大於）：粗體＋底線，直接設定在儲存格上
    var std = opts.std || {}, over = 0;
    rows.forEach(function (r, i) {
      var row = ws.getRow(i + 2);
      [['DAY', 4], ['EVE', 5], ['NIGHT', 6]].forEach(function (x) {
        var lim = std[x[0]];
        if (typeof lim === 'number' && isFinite(lim) && typeof r[x[0]] === 'number' && r[x[0]] > lim) { row.getCell(x[1]).font = { bold: true, underline: true }; over++; }
      });
    });
    wb.overCount = over;
    ws.getColumn(3).numFmt = 'yyyy/mm/dd';
    for (var c = 4; c <= 6; c++) ws.getColumn(c).numFmt = '0.0';
    styleSheet(ws, [12, 16, 12, 9, 9, 9, 44]);
    if (opts.periods) {
      var info = wb.addWorksheet('時段說明');
      info.addRow(['本報表的日／晚／夜時段（以 8/1 為例，結束時間不含）']);
      opts.periods.split('；').forEach(function (t) { info.addRow([t]); });
      if (opts.std) { info.addRow([]); info.addRow(['噪音管制標準：日間 ' + opts.std.DAY + '、晚間 ' + opts.std.EVE + '、夜間 ' + opts.std.NIGHT + ' dB(A)（超過者以粗體＋底線標示）']); }
      info.getColumn(1).width = 70; info.getRow(1).font = { bold: true };
    }
    return wb;
  }

  var api = {
    workbookToSheets: workbookToSheets, hiddenSheetNames: hiddenSheetNames,
    buildAirWorkbook: buildAirWorkbook, buildNoiseWorkbook: buildNoiseWorkbook, cellValue: cellValue
  };
  root.EnvXlsx = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
