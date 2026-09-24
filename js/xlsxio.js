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

  // 欄寬規則（使用者 2026-09-24 指定）：備註以外的欄位依內容自動欄寬、不換行；
  // 備註欄也依內容自動欄寬，但最寬 noteMax，只有超過的（很長的備註）才換行。nCols：欄數
  function styleSheet(ws, nCols, noteMax) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    var h = ws.getRow(1);
    h.font = { bold: true };
    h.alignment = { vertical: 'middle', horizontal: 'center' };
    h.eachCell(function (c) { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; });
    var noteCol = 0; h.eachCell(function (c, cn) { if (c.value === '備註') noteCol = cn; });
    Core.xlAutoFit(ws);
    if (noteCol) Core.xlWrapCol(ws, noteCol, Math.min(ws.getColumn(noteCol).width || 40, noteMax || 70));
    Core.xlFitHeights(ws);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nCols } };
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
  // 使用者 2026-09-24 改回：並列的多個方位維持以「、」分隔、不換行
  function dirLines(v) { return v; }
  /** 風向欄：置中、不換行（欄寬依內容） */
  function dirCells(ws, cols, n) {
    for (var i = 2; i <= n + 1; i++) {
      var row = ws.getRow(i), lines = 1;
      cols.forEach(function (c) {
        var cell = row.getCell(c);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        if (typeof cell.value === 'string') lines = Math.max(lines, cell.value.split('\n').length);
      });
      if (lines > 1) row.eachCell({ includeEmpty: false }, function (cell, cn) { if (cols.indexOf(cn) < 0) cell.alignment = Object.assign({}, cell.alignment || {}, { vertical: 'middle' }); });
      // 列高由 styleSheet 依風向行數與備註長度一起估算
    }
  }
  /** 「最頻風向說明」分頁：說明各最頻風向欄的算法 */
  function addWindHelp(wb) {
    var h = wb.addWorksheet('最頻風向說明');
    var lines = [
      ['欄位', '算法'],
      ['共同規則', '只採計同一小時風速有效且 ≥ 0.3 m/s 的風向（剛好 0.3 要計入）；全天風速都 < 0.3 寫「<0.3」；設備異常或維護沒有測值寫「－」。方位只寫方位，不加「風」字。'],
      ['最頻風向(8方位)', '風向角度直接換算 8 方位，每方位 45°：北 337.5°～22.5°、東北 22.5°～67.5°……依此類推（剛好在分界的角度歸下一個方位）。取當日出現次數最多者；並列最多時全部列出（北起順時針，以「、」分隔）。'],
      ['最頻風向(16方位)', '風向角度直接換算 16 方位，每方位 22.5°：北 348.75°～11.25°、北北東 11.25°～33.75°……依此類推。取當日出現次數最多者；並列最多時全部列出。8 方位不是由 16 方位合併而來，兩者扇區邊界不同，結果不一定能互相推得。'],
      ['最頻風向16(風速大)\n最頻風向8(風速大)', '「16」＝用 16 方位算、「8」＝用 8 方位算。沒有並列時＝一般最頻風向。並列時，計算每個並列方位在當日採計小時的平均風速，取平均風速最大的方位；平均風速也相同（或這台沒有風速欄）時仍全部列出。'],
      ['最頻風向16(相鄰方位)\n最頻風向8(相鄰方位)', '「16」＝用 16 方位算、「8」＝用 8 方位算。沒有並列時＝一般最頻風向。並列時，每個並列方位把自己和左右相鄰兩個方位的次數加總（例：16 方位的「北」＝北北西＋北＋北北東；8 方位的「北」＝西北＋北＋東北），取總和最大的方位；總和也相同時仍全部列出。'],
      ['例子', '某天 16 方位採計 5 小時：北 2 小時（風速 1.0、1.0）、南 2 小時（風速 3.0、3.0）、北北東 1 小時。\n最頻風向(16方位)＝「北、南」（並列）；最頻風向16(風速大)＝「南」（南平均 3.0 > 北 1.0）；最頻風向16(相鄰方位)＝「北」（北＋北北西＋北北東＝3 > 南＋南南東＋南南西＝2）。\n同一天用 8 方位：北北東(22°)落在 8 方位的「北」，北共 3 小時，沒有並列，所以 8 方位三欄都是「北」。'],
      ['欄位順序', '…WS平均、最頻風向8(風速大)（報告主要來源）、日累積雨量(mm)（有勾選才有）、備註、最頻風向(16方位)、最頻風向16(風速大)、最頻風向16(相鄰方位)、最頻風向(8方位)、最頻風向8(相鄰方位)（備註右側各欄為參考用）。\n8 方位並列時，備註會寫「8方位最頻風向並列（…），取平均風速較大者」。並列的多個方位以「、」分隔（北起順時針）。'],
      ['注意', '「風速大」「相鄰方位」兩種欄只是並列時挑一個的參考算法，不是官方規定；報告引用時請寫明採用哪一種。']
    ];
    // 說明文字：固定欄寬、自動換行
    lines.forEach(function (l) { h.addRow(l); });
    h.getColumn(1).width = 24; h.getColumn(2).width = 110;
    h.eachRow(function (row, rn) {
      row.eachCell(function (c) { c.alignment = { vertical: 'top', wrapText: true }; c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
      if (rn === 1) { row.font = { bold: true }; row.eachCell(function (c) { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } }; }); }
      else row.getCell(1).font = { bold: true };
    });
    Core.xlFitHeights(h);
  }
  function buildAirWorkbook(ExcelJS, rows, opts) {
    opts = opts || {};
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('空氣品質日均');
    // 欄位順序（使用者 2026-09-24 指定）：…WS平均、最頻風向8(風速大)（報告主要來源）、[日累積雨量]、備註、
    // 其他最頻風向欄接在備註右側（參考用）。並列的多個方位以「、」分隔、不換行；只有備註欄換行。
    var WD_EXTRA = [['WD', '最頻風向(16方位)'], ['WD16S', '最頻風向16(風速大)'], ['WD16A', '最頻風向16(相鄰方位)'], ['WD8', '最頻風向(8方位)'], ['WD8A', '最頻風向8(相鄰方位)']];
    var head = ['感測器編號', '感測器名稱', '日期', 'TMP平均', 'HUM平均', 'PM10平均', 'PM25平均', 'TVOC平均', 'WS平均', '最頻風向8(風速大)'];
    if (opts.includeRain) head.push('日累積雨量(mm)');
    head.push('備註');
    WD_EXTRA.forEach(function (x) { head.push(x[1]); });
    ws.addRow(head);
    rows.forEach(function (r) {
      var line = [r.id, r.name, dateCell(r.date)].concat(['TMP', 'HUM', 'PM10', 'PM25', 'TVOC', 'WS'].map(function (f) { return cellOr(r, f, r[f]); }));
      line.push(cellOr(r, 'WD', r.WD8S)); // 主要來源：8 方位、並列時取平均風速較大者
      if (opts.includeRain) line.push(cellOr(r, 'RA', r.RA));
      line.push(r.note);
      WD_EXTRA.forEach(function (x) { line.push(cellOr(r, 'WD', r[x[0]])); });
      ws.addRow(line);
    });
    var cRain = opts.includeRain ? 11 : 0, cNote = opts.includeRain ? 12 : 11;
    ws.getColumn(3).numFmt = 'yyyy/mm/dd';
    for (var c = 4; c <= 9; c++) ws.getColumn(c).numFmt = '0.0';
    if (cRain) ws.getColumn(cRain).numFmt = '0.0';
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
    centerNA(ws, 4, head.length);
    var dirCols = [10]; for (var e = 1; e <= WD_EXTRA.length; e++) dirCols.push(cNote + e);
    dirCells(ws, dirCols, rows.length);
    styleSheet(ws, head.length, 70);
    addWindHelp(wb);
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
    styleSheet(ws, 7, 70);
    if (opts.periods) {
      var info = wb.addWorksheet('時段說明');
      info.addRow(['本報表的日／晚／夜時段（以 8/1 為例，結束時間不含）']);
      opts.periods.split('；').forEach(function (t) { info.addRow([t]); });
      if (opts.std) { info.addRow([]); info.addRow(['噪音管制標準：日間 ' + opts.std.DAY + '、晚間 ' + opts.std.EVE + '、夜間 ' + opts.std.NIGHT + ' dB(A)（超過者以粗體＋底線標示）']); }
      Core.xlWrapCol(info, 1, 70); Core.xlFitHeights(info); info.getRow(1).font = { bold: true };
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
