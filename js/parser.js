/*
 * 數據月報解析 — 由「儲存格內容」判讀，不靠檔名、不靠固定欄位位置。
 * 輸入：[{name: 工作表名稱, rows: 二維陣列（Date / number / string / null）}]
 * 輸出：{sensors:[...], issues:[{level:'error'|'warn'|'info', sheet, msg}]}
 * 有 error 的檔案整份不匯入（例如同一工作表內時間重複）。
 */
(function (root) {
  'use strict';
  var Core = root.EnvCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  // 表頭 → 欄位代碼（整段開頭錨定，避免子字串誤判）
  var HEADER_RULES = [
    { f: 'TS', re: /^\s*(date\s*time|datetime|日期\s*時間|時間|日期|時間戳記)\s*$/i },
    { f: 'TMP', re: /^\s*(TMP|溫度|氣溫)(\b|\s|℃|\(|（|$)/i },
    { f: 'HUM', re: /^\s*(HUM|RH|濕度|相對濕度)(\b|\s|%|\(|（|$)/i },
    { f: 'PM25', re: /^\s*PM\s*2[._]?5(\b|\s|\(|（|$)/i },
    { f: 'PM10', re: /^\s*PM\s*10(\b|\s|\(|（|$)/i },
    { f: 'TVOC', re: /^\s*TVOC(\b|\s|\(|（|$)/i },
    // 氣體類（有這些測項的微型感測器也能匯入，⑨ 可和環境部測站比對）
    { f: 'SO2', re: /^\s*(SO\s*2|SO₂|二氧化硫)(\b|\s|\(|（|$)/i },
    { f: 'NO2', re: /^\s*(NO\s*2|NO₂|二氧化氮)(\b|\s|\(|（|$)/i },
    { f: 'NOX', re: /^\s*(NO\s*x|NOₓ|氮氧化物)(\b|\s|\(|（|$)/i },
    { f: 'NO', re: /^\s*(NO|一氧化氮)(\s|\(|（|$)/i },
    { f: 'CO2', re: /^\s*(CO\s*2|CO₂|二氧化碳)(\b|\s|\(|（|$)/i },
    { f: 'CO', re: /^\s*(CO|一氧化碳)(\s|\(|（|$)/i },
    { f: 'O3', re: /^\s*(O\s*3|O₃|臭氧)(\b|\s|\(|（|$)/i },
    { f: 'NMHC', re: /^\s*(NMHC|非甲烷碳氫化合物)(\b|\s|\(|（|$)/i },
    { f: 'THC', re: /^\s*(THC|總碳氫化合物)(\b|\s|\(|（|$)/i },
    { f: 'CH4', re: /^\s*(CH\s*4|CH₄|甲烷)(\b|\s|\(|（|$)/i },
    { f: 'WD', re: /^\s*(WD|風向)(\b|\s|\(|（|$)/i },
    { f: 'WS', re: /^\s*(WS|風速)(\b|\s|\(|（|$)/i },
    { f: 'RA', re: /^\s*(RA|RAIN|雨量|降雨量)(\b|\s|\(|（|$)/i },
    { f: 'LMAX', re: /^\s*(Leq\s*\(\s*max\s*\)|Lmax|Leq\s*max)/i },
    { f: 'LEQ', re: /^\s*Leq(?!\s*\(\s*max)(\b|\s|\(|（|$)/i },
    { f: 'NOTE', re: /^\s*(備註|備考|說明|remark|note)s?\s*$/i }
  ];

  function classifyHeader(text) {
    if (text === null || text === undefined) return null;
    var s = String(text).trim();
    if (!s) return null;
    for (var i = 0; i < HEADER_RULES.length; i++) if (HEADER_RULES[i].re.test(s)) return HEADER_RULES[i].f;
    return null;
  }

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  /** 儲存格 → 'YYYY-MM-DD HH:MM'（牆上時間）；無法判讀回傳 null。另回傳秒數是否非 0 */
  function toTs(v) {
    var y, mo, d, h = 0, mi = 0, sec = 0;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // ExcelJS 把 Excel 的牆上時間放在 UTC 欄位
      y = v.getUTCFullYear(); mo = v.getUTCMonth() + 1; d = v.getUTCDate();
      h = v.getUTCHours(); mi = v.getUTCMinutes(); sec = v.getUTCSeconds() + v.getUTCMilliseconds() / 1000;
      if (sec >= 59.5) { // 浮點誤差造成 00:59:59.999 之類
        var t = new Date(Date.UTC(y, mo - 1, d, h, mi) + 60000);
        y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); h = t.getUTCHours(); mi = t.getUTCMinutes(); sec = 0;
      } else if (sec < 0.5) sec = 0;
    } else if (typeof v === 'number' && v > 20000 && v < 80000) {
      // Excel 序號日期
      var ms = Math.round((v - 25569) * 86400) * 1000;
      var t2 = new Date(ms);
      y = t2.getUTCFullYear(); mo = t2.getUTCMonth() + 1; d = t2.getUTCDate(); h = t2.getUTCHours(); mi = t2.getUTCMinutes(); sec = t2.getUTCSeconds();
    } else if (typeof v === 'string') {
      var m = v.trim().match(/^(\d{2,4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (!m) return null;
      y = Number(m[1]); if (y < 1911) y += 1911; // 民國年
      mo = Number(m[2]); d = Number(m[3]); h = m[4] ? Number(m[4]) : 0; mi = m[5] ? Number(m[5]) : 0; sec = m[6] ? Number(m[6]) : 0;
      if (h === 24 && mi === 0) { // 24:00 → 隔日 00:00
        var t3 = new Date(Date.UTC(y, mo - 1, d + 1)); y = t3.getUTCFullYear(); mo = t3.getUTCMonth() + 1; d = t3.getUTCDate(); h = 0;
      }
    } else return null;
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h < 24 && mi >= 0 && mi < 60)) return null;
    var chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCDate() !== d) return null;
    return { ts: y + '-' + pad(mo) + '-' + pad(d) + ' ' + pad(h) + ':' + pad(mi), sec: sec };
  }

  function parseSheet(sheet, issues) {
    var rows = sheet.rows || [];
    var name = String(sheet.name || '').trim();
    var push = function (level, msg) { issues.push({ level: level, sheet: name, msg: msg }); };

    // 1. 找表頭列：前 15 列中，能辨識出「時間」＋至少一個監測欄位的那一列
    var hdrRow = -1, map = null;
    for (var r = 0; r < Math.min(15, rows.length) && hdrRow < 0; r++) {
      var row = rows[r] || [], m = {}, n = 0, ts = -1;
      for (var c = 0; c < row.length; c++) {
        var f = classifyHeader(row[c]);
        if (!f) continue;
        if (f === 'TS') { if (ts < 0) ts = c; continue; }
        if (m[f] !== undefined) { m.__dup = (m.__dup || []).concat([f]); continue; }
        m[f] = c; if (f !== 'NOTE') n++;
      }
      if (n > 0) { hdrRow = r; map = m; map.TS = ts; }
    }
    if (hdrRow < 0) {
      push('info', '找不到可辨識的監測欄位（TMP、PM10、Leq…），此工作表略過。');
      return null;
    }
    if (map.__dup) {
      push('error', '第 ' + (hdrRow + 1) + ' 列表頭有重複的欄位：' + map.__dup.join('、') + '。請確認是哪一欄才是正確的，刪掉多餘的欄後再匯入。');
      return null;
    }
    var hdr = rows[hdrRow];

    // 2. 時間欄：表頭沒寫時，找資料最多是日期的那一欄
    if (map.TS < 0) {
      var best = -1, bestN = 0;
      for (var c2 = 0; c2 < hdr.length; c2++) {
        var k = 0;
        for (var r2 = hdrRow + 1; r2 < Math.min(rows.length, hdrRow + 50); r2++) if (toTs((rows[r2] || [])[c2])) k++;
        if (k > bestN) { bestN = k; best = c2; }
      }
      if (best < 0) { push('error', '找不到日期時間欄。'); return null; }
      map.TS = best;
      push('warn', '表頭沒有標示日期時間欄，依內容判定第 ' + (best + 1) + ' 欄為日期時間。');
    }

    // 3. 感測器編號與名稱：工作表名稱是一串數字就用它；否則從表頭其他文字找 7 位數字
    var label = '';
    for (var c3 = 0; c3 < hdr.length; c3++) {
      if (c3 === map.TS) continue;
      var t = hdr[c3];
      if (t === null || t === undefined || String(t).trim() === '') continue;
      if (classifyHeader(t)) continue;
      label = String(t).trim(); break;
    }
    var id = null;
    if (/^\d{4,}$/.test(name)) id = name;
    else {
      var mm = label.match(/\d{7}/) || name.match(/\d{7}/);
      if (mm) id = mm[0];
    }
    if (!id) { push('error', '無法判讀感測器編號（工作表名稱不是編號，表頭也找不到 7 位數編號）。'); return null; }
    if (label && label.indexOf(id) < 0 && /\d{7}/.test(label)) {
      push('warn', '工作表名稱 ' + name + ' 與表頭文字「' + label + '」裡的編號不同，以工作表名稱為準，請確認。');
    }
    var defaultName = label.replace(id, '').replace(/[\s_]+$/, '').replace(/^[\s_]+/, '').trim();

    // 4. 未辨識的欄位
    var unknown = [];
    for (var c4 = 0; c4 < hdr.length; c4++) {
      var h = hdr[c4];
      if (c4 === map.TS || h === null || h === undefined || String(h).trim() === '') continue;
      if (!classifyHeader(h) && String(h).trim() !== label) unknown.push(String(h).trim());
    }
    if (unknown.length) push('warn', '有無法辨識的欄位，未匯入：' + unknown.join('、'));

    var fields = Object.keys(map).filter(function (f) { return f !== 'TS' && f !== 'NOTE' && f.indexOf('__') !== 0; });
    var out = [], seen = {}, dups = [], skipped = 0, invalid = {}, nonHour = 0;
    fields.forEach(function (f) { invalid[f] = 0; });
    for (var r5 = hdrRow + 1; r5 < rows.length; r5++) {
      var row5 = rows[r5] || [];
      var tv = toTs(row5[map.TS]);
      if (!tv) {
        var any = row5.some(function (x) { return x !== null && x !== undefined && String(x).trim() !== ''; });
        if (any) skipped++;
        continue;
      }
      if (tv.sec !== 0 || tv.ts.slice(14) !== '00') nonHour++;
      if (seen[tv.ts]) { dups.push({ ts: tv.ts, rows: [seen[tv.ts], r5 + 1] }); continue; }
      seen[tv.ts] = r5 + 1;
      var v = {};
      fields.forEach(function (f) {
        var raw = row5[map[f]];
        var val = Core.validValue(raw);
        if (val === null) invalid[f]++;
        v[f] = val;
      });
      var rec = { ts: tv.ts, v: v };
      if (map.NOTE !== undefined) {
        var nt = row5[map.NOTE];
        if (nt !== null && nt !== undefined && String(nt).trim() !== '') rec.note = String(nt).trim();
      }
      out.push(rec);
    }
    if (dups.length) {
      push('error', '同一個時間出現兩次以上，共 ' + dups.length + ' 個時間重複，例如 ' +
        dups.slice(0, 3).map(function (d) { return d.ts + '（第 ' + d.rows.join('、') + ' 列）'; }).join('；') +
        '。請刪除重複的列後再匯入。');
    }
    if (skipped) push('info', '有 ' + skipped + ' 列的第一欄不是日期時間（例如統計列），未匯入。');
    if (nonHour) push('warn', '有 ' + nonHour + ' 筆時間不是整點。備註欄的「有效資料 X 小時」是以筆數計算，請確認這份資料是不是逐時資料。');
    if (!out.length) { push('warn', '沒有任何資料列。'); }
    var months = {};
    out.forEach(function (x) { months[x.ts.slice(0, 7)] = (months[x.ts.slice(0, 7)] || 0) + 1; });
    return {
      id: id, label: label, defaultName: defaultName || id, fields: fields, rows: out,
      invalid: invalid, months: months, sheet: name, blocked: dups.length > 0
    };
  }

  function parseWorkbook(sheets) {
    var issues = [], sensors = [], byId = {};
    sheets.forEach(function (sh) {
      var s = parseSheet(sh, issues);
      if (!s) return;
      if (byId[s.id]) {
        issues.push({ level: 'error', sheet: s.sheet, msg: '感測器 ' + s.id + ' 在工作表「' + byId[s.id].sheet + '」與「' + s.sheet + '」都出現。請確認哪一張才是正確的，刪掉另一張後再匯入。' });
        return;
      }
      byId[s.id] = s; sensors.push(s);
    });
    var blocked = issues.some(function (i) { return i.level === 'error'; });
    return { sensors: sensors, issues: issues, blocked: blocked };
  }

  var api = { parseWorkbook: parseWorkbook, parseSheet: parseSheet, classifyHeader: classifyHeader, toTs: toTs };
  root.EnvParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
