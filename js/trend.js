/*
 * 環境部測站比對趨勢圖：匯入環境部空氣品質小時值 CSV、日平均、趨勢圖（canvas 高解析度）與可編輯 Excel（原生折線圖）。
 */
(function (root) {
  'use strict';
  var Core = root.EnvCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  // ---------------- CSV ----------------
  function splitCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] || '').trim() !== ''; });
  }
  function num(v) {
    var t = String(v === undefined || v === null ? '' : v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;   // x、#、*、空白等：無效
    var n = Number(t);
    return n >= 0 ? n : null;
  }
  function normTs(t) {
    var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(t).trim());
    if (!m) return null;
    var p = function (x) { return (x.length < 2 ? '0' : '') + x; };
    return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + ' ' + p(m[4]) + ':00';
  }
  /**
   * 環境部「空氣品質小時值」CSV（siteid, sitename, county, itemid, itemname, itemengname, itemunit, monitordate, concentration）
   * 回傳 { ok, error, sites:{名稱:筆數}, hours:{ts:{PM10, PM25}}, invalid:{PM10,PM25}, total:{PM10,PM25}, months:[] }
   */
  function parseMoenvCsv(text) {
    text = String(text).replace(/^﻿/, '');
    var rows = splitCsv(text);
    if (!rows.length) return { ok: false, error: '檔案是空的。' };
    var h = rows[0].map(function (x) { return x.trim().toLowerCase(); });
    var ci = function (names) { for (var i = 0; i < names.length; i++) { var k = h.indexOf(names[i]); if (k >= 0) return k; } return -1; };
    var cItem = ci(['itemengname', 'itemname', '測項', '測項英文名稱']), cDate = ci(['monitordate', 'datacreationdate', '監測日期', '日期']), cVal = ci(['concentration', '濃度', '數值']), cSite = ci(['sitename', '測站名稱', '測站']);
    if (cItem < 0 || cDate < 0 || cVal < 0) return { ok: false, error: '看不懂這個檔案的欄位。請使用環境部「空氣品質小時值」下載的 CSV（要有 itemengname、monitordate、concentration 欄）。' };
    var recs = [];
    for (var r = 1; r < rows.length; r++) recs.push({ item: rows[r][cItem], date: rows[r][cDate], value: rows[r][cVal], site: cSite >= 0 ? rows[r][cSite] : '' });
    return fromRecords(recs);
  }
  /** API 回傳的 JSON 陣列（欄位名稱不分大小寫：itemengname、monitordate、concentration、sitename） */
  function parseMoenvJson(arr) {
    if (!Array.isArray(arr)) return { ok: false, error: '回傳的不是資料清單。' };
    var recs = arr.map(function (o) {
      var g = {}; Object.keys(o || {}).forEach(function (k) { g[k.toLowerCase()] = o[k]; });
      return { item: g.itemengname !== undefined ? g.itemengname : g.itemname, date: g.monitordate, value: g.concentration, site: g.sitename };
    });
    return fromRecords(recs, true);
  }
  function fromRecords(recs, allowEmpty) {
    var out = { ok: true, sites: {}, hours: {}, invalid: { PM10: 0, PM25: 0 }, total: { PM10: 0, PM25: 0 }, badTime: 0 };
    for (var r = 0; r < recs.length; r++) {
      var x = recs[r];
      var item = String(x.item || '').trim().toUpperCase().replace(/\s/g, '');
      var f = item === 'PM10' ? 'PM10' : (item === 'PM2.5' || item === 'PM25') ? 'PM25' : null;
      if (!f) continue;
      var ts = normTs(x.date);
      if (!ts) { out.badTime++; continue; }
      var sn = String(x.site || '').trim(); if (sn) out.sites[sn] = (out.sites[sn] || 0) + 1;
      var v = num(x.value);
      out.total[f]++;
      if (v === null) out.invalid[f]++;
      var o = out.hours[ts] || (out.hours[ts] = { PM10: null, PM25: null });
      o[f] = v;
    }
    var ms = {}; Object.keys(out.hours).forEach(function (t) { ms[t.slice(0, 7)] = true; });
    out.months = Object.keys(ms).sort();
    if (!out.months.length && !allowEmpty) return { ok: false, error: '檔案裡沒有 PM10 或 PM2.5 的資料。' };
    return out;
  }
  // ★ 維護重點：環境部自動抓取的網址與金鑰寫在這裡（畫面上沒有設定欄位）。
  //   環境部改網址、金鑰失效而抓不到時，改 DEFAULT_API／DEFAULT_KEY 即可。詳見 README.md「給維護者（含 AI）」。
  //   資料集 AQX_P_221：https://data.moenv.gov.tw/dataset/detail/AQX_P_221
  var DEFAULT_API = 'https://data.moenv.gov.tw/api/v2/aqx_p_221?format=json&limit=1000&offset={offset}&api_key={key}&filters=monitordate,GR,{from}|monitordate,LT,{to}|itemengname,EQ,{item}';
  var DEFAULT_KEY = '540e2ca4-41e1-4186-8497-fdd67024ac44'; // 環境部「透過API下載歷史資料操作手冊」裡的範例金鑰；建議改用自己申請的
  function apiUrl(tpl, o) {
    return String(tpl).trim().replace(/\{(key|from|to|item|offset)\}/g, function (m, k) { return encodeURIComponent(k === 'key' ? (o.key || '') : String(o[k])); }).replace(/\|/g, '%7C');
  }
  function nextMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return y + '-' + (m < 10 ? '0' : '') + m; }
  /** 抓一個月的 PM10、PM2.5（每頁 1000 筆，自動翻頁）。fetchFn(url) → Promise<json> */
  function fetchMonth(fetchFn, tpl, key, ym) {
    var from = ym + '-01 00:00', to = nextMonth(ym) + '-01 00:00', all = [];
    function page(item, off) {
      return fetchFn(apiUrl(tpl, { key: key, from: from, to: to, item: item, offset: off })).then(function (j) {
        if (!Array.isArray(j)) { var e = new Error('環境部回傳的不是資料：' + String(JSON.stringify(j)).slice(0, 200)); e.body = j; throw e; }
        all = all.concat(j);
        if (j.length >= 1000 && off < 20000) return page(item, off + 1000);
      });
    }
    return page('PM10', 0).then(function () { return page('PM2.5', 0); }).then(function () {
      var p = parseMoenvJson(all);
      var h = {}; Object.keys(p.hours).forEach(function (t) { if (t.slice(0, 7) === ym) h[t] = p.hours[t]; });
      p.hours = h; p.months = Object.keys(h).length ? [ym] : [];
      return p;
    });
  }
  /** 合併到已存的環境部資料：同一小時以新的為準 */
  function mergeMoenv(store, parsed) {
    var hours = {}, replaced = 0, added = 0;
    Object.keys((store && store.hours) || {}).forEach(function (t) { hours[t] = store.hours[t]; });
    Object.keys(parsed.hours).forEach(function (t) { if (hours[t]) replaced++; else added++; hours[t] = parsed.hours[t]; });
    return { hours: hours, replaced: replaced, added: added };
  }
  function moenvMonths(hours) {
    var m = {};
    Object.keys(hours || {}).forEach(function (t) {
      var k = t.slice(0, 7), o = m[k] || (m[k] = { hours: 0, PM10: 0, PM25: 0 });
      o.hours++; if (hours[t].PM10 !== null) o.PM10++; if (hours[t].PM25 !== null) o.PM25++;
    });
    return m;
  }
  /** 環境部日平均（當日有效小時的平均，四捨五入到小數 1 位，與報表相同） */
  function moenvDaily(hours, from, to) {
    var by = {};
    Object.keys(hours || {}).forEach(function (t) {
      var d = t.slice(0, 10); if (d < from || d > to) return;
      var o = by[d] || (by[d] = { PM10: [], PM25: [] });
      if (hours[t].PM10 !== null) o.PM10.push(hours[t].PM10);
      if (hours[t].PM25 !== null) o.PM25.push(hours[t].PM25);
    });
    var out = {};
    Object.keys(by).forEach(function (d) { out[d] = { PM10: Core.exactMean1(by[d].PM10), PM25: Core.exactMean1(by[d].PM25) }; });
    return out;
  }

  // ---------------- 趨勢圖 ----------------
  var FONT = '"Microsoft JhengHei","微軟正黑體","PingFang TC","Noto Sans CJK TC","Noto Sans TC",sans-serif';
  // 感測器用的顏色（刻意不用紅色系，紅色只給環境部）
  var PALETTE = ['#1f77b4', '#2ca02c', '#9467bd', '#8c564b', '#17becf', '#bcbd22', '#7f7f7f', '#e377c2', '#393b79', '#637939', '#8c6d31', '#6b6ecf', '#98df8a', '#aec7e8', '#c5b0d5', '#9edae5', '#dbdb8d', '#5254a3', '#b5cf6b', '#c49c94', '#3182bd', '#31a354', '#756bb1', '#636363'];
  var REF_COLOR = '#e60000';
  function niceScale(min, max, want) { return root.EnvBox ? root.EnvBox.niceScale(min, max, want) : (typeof require !== 'undefined' ? require('./boxplot.js').niceScale(min, max, want) : null); }
  function fmtTick(v, step) { var dec = 0; while (dec < 4 && Math.abs(Math.round(step * Math.pow(10, dec)) - step * Math.pow(10, dec)) > 1e-6) dec++; return v.toFixed(dec); }
  function md(ts) { return Number(ts.slice(5, 7)) + '/' + Number(ts.slice(8, 10)); }

  /**
   * spec = { title, yTitle, xTitle, x:[ts...], series:[{name, color, values:[...], ref}], yMin, yMax, showTitle }
   * 圖例放上方、自動換行；日期標籤依寬度自動跳著標，不重疊；環境部線條紅色加粗、畫在最上層。
   */
  function drawTrend(canvas, spec, scale) {
    scale = scale || 1;
    var ctx = canvas.getContext('2d');
    var fs = { title: 22, axis: 17, tick: 14, legend: 14 };
    var n = spec.x.length;
    var plotW = Math.max(900, Math.min(2400, n * (spec.hourly ? 1.2 : 14)));
    var pad = 24;
    // 刻度
    var lo = Infinity, hi = -Infinity;
    spec.series.forEach(function (s) { s.values.forEach(function (v) { if (v === null || v === undefined) return; if (v < lo) lo = v; if (v > hi) hi = v; }); });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var sc = niceScale(typeof spec.yMin === 'number' ? spec.yMin : Math.min(0, lo), typeof spec.yMax === 'number' ? spec.yMax : hi, 7);
    if (typeof spec.yMin === 'number') sc.min = spec.yMin;
    if (typeof spec.yMax === 'number') sc.max = spec.yMax;
    sc.ticks = sc.ticks.filter(function (t) { return t >= sc.min - 1e-9 && t <= sc.max + 1e-9; });
    ctx.font = fs.tick + 'px ' + FONT;
    var tickW = sc.ticks.reduce(function (a, t) { return Math.max(a, ctx.measureText(fmtTick(t, sc.step)).width); }, 0);
    var left = pad + fs.axis * 1.3 + 14 + tickW + 10;
    var right = pad + 16;
    var totalW = left + plotW + right;
    // 圖例排版（環境部放第一個）
    ctx.font = fs.legend + 'px ' + FONT;
    var order = spec.series.filter(function (s) { return s.ref; }).concat(spec.series.filter(function (s) { return !s.ref; }));
    var items = order.map(function (s) { ctx.font = (s.ref ? 'bold ' : '') + fs.legend + 'px ' + FONT; return { s: s, w: 34 + ctx.measureText(s.name).width + 18 }; });
    // 圖例排成表格：每一欄同寬，多行時上下對齊
    var maxLine = totalW - 2 * pad, colW = items.reduce(function (a, it) { return Math.max(a, it.w); }, 0);
    var nCol = Math.max(1, Math.min(items.length, Math.floor(maxLine / colW))), lines = [];
    for (var li = 0; li < items.length; li += nCol) lines.push(items.slice(li, li + nCol));
    var legRowH = fs.legend + 12, legH = lines.length * legRowH;
    var top = pad + (spec.showTitle ? fs.title * 1.5 + 6 : 0) + legH + 22;
    var H = 440;
    // 日期標籤
    var days = [], seen = {};
    spec.x.forEach(function (t, i) { var d = t.slice(0, 10); if (!seen[d]) { seen[d] = true; days.push({ i: i, d: d }); } });
    ctx.font = fs.tick + 'px ' + FONT;
    var lblW = ctx.measureText('12/31').width + 12;
    var perDay = plotW / Math.max(1, days.length);
    var step = [1, 2, 3, 5, 7, 10, 14, 15, 30, 60, 90].filter(function (k) { return perDay * k >= lblW; })[0] || 120;
    var bottom = pad + fs.tick * 1.5 + 10 + fs.tick * 1.8 + fs.axis * 1.3 + 6; // 日期列＋月份列＋軸名稱
    var W = Math.ceil(totalW), Ht = Math.ceil(top + H + bottom);
    canvas.width = Math.ceil(W * scale); canvas.height = Math.ceil(Ht * scale);
    ctx = canvas.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, Ht);
    var x0 = left, y0 = top;
    var X = function (i) { return x0 + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
    var Y = function (v) { return y0 + H - (v - sc.min) / (sc.max - sc.min) * H; };
    ctx.textBaseline = 'middle';
    if (spec.showTitle) { ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = 'bold ' + fs.title + 'px ' + FONT; ctx.fillText(spec.title, x0 + plotW / 2, pad + fs.title * 0.7); }
    // 圖例
    var ly = pad + (spec.showTitle ? fs.title * 1.5 + 6 : 0) + fs.legend / 2 + 2;
    var gridX = (W - nCol * colW) / 2;
    lines.forEach(function (ln) {
      var lx = gridX;
      ln.forEach(function (it) {
        ctx.strokeStyle = it.s.color; ctx.lineWidth = it.s.ref ? 4 : 2;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 26, ly); ctx.stroke();
        ctx.fillStyle = it.s.ref ? REF_COLOR : '#000'; ctx.textAlign = 'left'; ctx.font = (it.s.ref ? 'bold ' : '') + fs.legend + 'px ' + FONT;
        ctx.fillText(it.s.name, lx + 32, ly);
        lx += colW;
      });
      ly += legRowH;
    });
    // 格線、Y 刻度
    ctx.font = fs.tick + 'px ' + FONT;
    sc.ticks.forEach(function (t) {
      var y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.textAlign = 'right'; ctx.fillText(fmtTick(t, sc.step), x0 - 10, y);
    });
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + H); ctx.lineTo(x0 + plotW, y0 + H); ctx.stroke();
    // X 日期
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    days.forEach(function (d, k) {
      if (k % step) return;
      var x = X(d.i);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y0 + H); ctx.lineTo(x, y0 + H + 5); ctx.stroke();
      var tx = Math.min(Math.max(x, x0 + lblW / 2 - 6), x0 + plotW - lblW / 2 + 6); // 頭尾不超出圖
      ctx.fillText(md(d.d), tx, y0 + H + 8);
    });
    // 月份列（像 Excel 的兩層類別）：月份名置中、月與月之間畫分隔線
    var months = []; days.forEach(function (d) { var m = d.d.slice(0, 7), L = months[months.length - 1]; if (!L || L.m !== m) months.push({ m: m, a: d.i, b: d.i }); else L.b = d.i; });
    var my = y0 + H + 8 + fs.tick * 1.5 + 4;
    ctx.font = fs.tick + 'px ' + FONT; ctx.textBaseline = 'top';
    months.forEach(function (m, k) {
      var xa = k === 0 ? x0 : (X(m.a) + X(m.a - 1)) / 2, xb = k === months.length - 1 ? x0 + plotW : (X(m.b) + X(m.b + 1)) / 2;
      ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xa, y0 + H); ctx.lineTo(xa, my + fs.tick * 1.3); ctx.stroke();
      if (k === months.length - 1) { ctx.beginPath(); ctx.moveTo(xb, y0 + H); ctx.lineTo(xb, my + fs.tick * 1.3); ctx.stroke(); }
      var label = Number(m.m.slice(5, 7)) + '月', w = ctx.measureText(label).width;
      if (xb - xa > w + 6) { ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(label, (xa + xb) / 2, my); }
    });
    // 線（感測器先畫，環境部最後畫在最上層）
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 2, plotW, H + 4); ctx.clip();
    spec.series.filter(function (s) { return !s.ref; }).concat(spec.series.filter(function (s) { return s.ref; })).forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.ref ? 3.2 : 1.3; ctx.lineJoin = 'round';
      ctx.beginPath(); var pen = false;
      s.values.forEach(function (v, i) {
        if (v === null || v === undefined) { pen = false; return; }
        if (!pen) { ctx.moveTo(X(i), Y(v)); pen = true; } else ctx.lineTo(X(i), Y(v));
      });
      ctx.stroke();
    });
    ctx.restore();
    // 軸標題
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold ' + fs.axis + 'px ' + FONT;
    ctx.fillText(spec.xTitle, x0 + plotW / 2, Ht - pad - fs.axis * 0.6);
    ctx.save(); ctx.translate(pad + fs.axis * 0.65, y0 + H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.yTitle, 0, 0); ctx.restore();
    return { width: W, height: Ht };
  }

  // ---------------- Excel（原生折線圖） ----------------
  function xesc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function qs(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }
  var FX = '<a:latin typeface="微軟正黑體"/><a:ea typeface="微軟正黑體"/>';
  function txt(sz, bold, rot) { return '<c:txPr><a:bodyPr rot="' + (rot || 0) + '"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + sz + '" b="' + (bold ? 1 : 0) + '"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>' + FX + '</a:defRPr></a:pPr><a:endParaRPr lang="zh-TW"/></a:p></c:txPr>'; }
  function titleXml(text, sz, rot) { return '<c:title><c:tx><c:rich><a:bodyPr rot="' + (rot || 0) + '" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + sz + '" b="1">' + FX + '</a:defRPr></a:pPr><a:r><a:rPr lang="zh-TW" sz="' + sz + '" b="1"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>' + FX + '</a:rPr><a:t>' + xesc(text) + '</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'; }
  function lineChartXml(o) {
    var ser = o.series.map(function (s, i) {
      var col = s.color.replace('#', '').toUpperCase();
      return '<c:ser><c:idx val="' + i + '"/><c:order val="' + i + '"/><c:tx><c:strRef><c:f>' + s.nameRef + '</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>' + xesc(s.name) + '</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
        '<c:spPr><a:ln w="' + (s.ref ? 38100 : 15875) + '" cap="rnd"><a:solidFill><a:srgbClr val="' + col + '"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>' +
        '<c:cat><c:numRef><c:f>' + o.catRef + '</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>' + s.valRef + '</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>';
    });
    // 環境部排在最後 → 畫在最上層
    var yScale = '<c:scaling><c:orientation val="minMax"/>' + (typeof o.yMax === 'number' ? '<c:max val="' + o.yMax + '"/>' : '') + (typeof o.yMin === 'number' ? '<c:min val="' + o.yMin + '"/>' : '<c:min val="0"/>') + '</c:scaling>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<c:date1904 val="0"/><c:lang val="zh-TW"/><c:roundedCorners val="0"/><c:chart>' + (o.showTitle ? titleXml(o.title, 1400) : '') + '<c:autoTitleDeleted val="' + (o.showTitle ? 0 : 1) + '"/><c:plotArea><c:layout/>' +
      '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' + ser.join('') + '<c:marker val="1"/><c:axId val="500000001"/><c:axId val="500000002"/></c:lineChart>' +
      '<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' + titleXml(o.xTitle, 1100) + '<c:numFmt formatCode="' + (o.hourly ? 'm/d hh:mm' : 'm/d') + '" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>' +
      '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></c:spPr>' + txt(900, false, -2700000) + '<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>' + (o.tickSkip ? '<c:tickLblSkip val="' + o.tickSkip + '"/><c:tickMarkSkip val="' + o.tickSkip + '"/>' : '') + '<c:noMultiLvlLbl val="0"/></c:catAx>' +
      '<c:valAx><c:axId val="500000002"/>' + yScale + '<c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' + titleXml(o.yTitle, 1100, -5400000) +
      '<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></c:spPr>' + txt(900) + '<c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>' +
      '</c:plotArea><c:legend><c:legendPos val="t"/><c:overlay val="0"/>' + txt(900) + '</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
      '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>';
  }
  function anchorXml(k, row, rows, cols) {
    return '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + row + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>' + cols + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + (row + rows) + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="' + (k + 1) + '" name="趨勢圖 ' + k + '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId' + k + '"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>';
  }
  /**
   * charts = [{sheet:'PM2.5', title, yTitle, xTitle, yMin, yMax, showTitle, x:[ts], series:[{name, color, ref, values}]}]
   * 每個測項一張資料表（日期｜各感測器｜環境部），「趨勢圖」工作表放全部折線圖（可編輯）。
   */
  function buildTrendWorkbook(ExcelJS, JSZip, charts, info, hourly) {
    var wb = new ExcelJS.Workbook();
    var gs = wb.addWorksheet('趨勢圖');
    var meta = [];
    charts.forEach(function (c) {
      var ws = wb.addWorksheet(c.sheet);
      ws.getRow(1).getCell(1).value = hourly ? '日期時間' : '日期';
      c.series.forEach(function (s, j) { ws.getRow(1).getCell(j + 2).value = s.name; });
      c.x.forEach(function (t, i) {
        var row = ws.getRow(i + 2), p = t.split(/[- :]/).map(Number);
        row.getCell(1).value = new Date(Date.UTC(p[0], p[1] - 1, p[2], p[3] || 0, p[4] || 0));
        c.series.forEach(function (s, j) { var v = s.values[i]; if (v !== null && v !== undefined) row.getCell(j + 2).value = v; });
      });
      ws.getColumn(1).numFmt = hourly ? 'yyyy/mm/dd hh:mm' : 'yyyy/mm/dd'; ws.getColumn(1).width = hourly ? 17 : 12;
      for (var j = 0; j < c.series.length; j++) { ws.getColumn(j + 2).width = 14; ws.getColumn(j + 2).numFmt = '0.0'; }
      ws.getRow(1).font = { bold: true }; ws.getRow(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
      var last = c.x.length + 1, sh = qs(c.sheet);
      meta.push({ c: c, catRef: sh + '!$A$2:$A$' + last, series: c.series.map(function (s, j) { var col = colName(j + 1); return { name: s.name, color: s.color, ref: s.ref, nameRef: sh + '!$' + col + '$1', valRef: sh + '!$' + col + '$2:$' + col + '$' + last }; }) });
    });
    var ex = wb.addWorksheet('說明');
    (info || []).forEach(function (t) { ex.addRow([t]); });
    ex.getColumn(1).width = 110;
    var days = charts.length ? (function () { var s = {}; charts[0].x.forEach(function (t) { s[t.slice(0, 10)] = 1; }); return Object.keys(s).length; })() : 0;
    var tickSkip = hourly ? Math.max(24, Math.ceil(days / 15) * 24) : Math.max(1, Math.ceil(days / 31));
    return wb.xlsx.writeBuffer().then(function (buf) { return JSZip.loadAsync(buf); }).then(function (zip) {
      return Promise.all([zip.file('xl/workbook.xml').async('string'), zip.file('xl/_rels/workbook.xml.rels').async('string'), zip.file('[Content_Types].xml').async('string')]).then(function (a) {
        var wbx = a[0], rels = a[1], ct = a[2];
        var rid = {}; rels.replace(/<Relationship\b[^>]*>/g, function (t) { var i = /Id="([^"]+)"/.exec(t), g = /Target="([^"]+)"/.exec(t); if (i && g) rid[i[1]] = g[1].replace(/^\/?xl\//, ''); return t; });
        var sheetFile = {}; wbx.replace(/<sheet\b[^>]*>/g, function (t) { sheetFile[/name="([^"]+)"/.exec(t)[1]] = rid[/r:id="([^"]+)"/.exec(t)[1]]; return t; });
        var anchors = '', drels = '', rowsPer = 30, cols = 20;
        meta.forEach(function (m, i) {
          var k = i + 1;
          zip.file('xl/charts/chart' + k + '.xml', lineChartXml({ series: m.series, catRef: m.catRef, title: m.c.title, xTitle: m.c.xTitle, yTitle: m.c.yTitle, yMin: m.c.yMin, yMax: m.c.yMax, showTitle: m.c.showTitle, hourly: hourly, tickSkip: tickSkip }));
          ct = ct.replace('</Types>', '<Override PartName="/xl/charts/chart' + k + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>');
          anchors += anchorXml(k, i * (rowsPer + 2), rowsPer, cols);
          drels += '<Relationship Id="rId' + k + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart' + k + '.xml"/>';
        });
        zip.file('xl/drawings/drawing1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + anchors + '</xdr:wsDr>');
        zip.file('xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + drels + '</Relationships>');
        ct = ct.replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
        zip.file('[Content_Types].xml', ct);
        var sf = 'xl/' + sheetFile['趨勢圖'], sr = sf.replace(/worksheets\/(sheet\d+\.xml)$/, 'worksheets/_rels/$1.rels');
        return zip.file(sf).async('string').then(function (x) {
          var rp = zip.file(sr) ? zip.file(sr).async('string') : Promise.resolve('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
          return rp.then(function (rx) {
            rx = rx.replace('</Relationships>', '<Relationship Id="rIdTrend" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
            if (x.indexOf('xmlns:r=') < 0) x = x.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
            var tag = '<drawing r:id="rIdTrend"/>', at = x.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
            x = at >= 0 ? x.slice(0, at) + tag + x.slice(at) : x.replace('</worksheet>', tag + '</worksheet>');
            zip.file(sf, x); zip.file(sr, rx);
            return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
          });
        });
      });
    });
  }

  /**
   * 自動 Y 軸上限：主要看趨勢，不為少數異常高值拉高。
   * 取「環境部最大值」與「感測器全部數值的第 99 百分位」較大者，再取整到漂亮的刻度；超過的點在圖頂端截斷。
   */
  function autoYMax(series) {
    var sv = [], rmax = 0, all = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v === null || v === undefined) return; all = Math.max(all, v); if (s.ref) rmax = Math.max(rmax, v); else sv.push(v); }); });
    sv.sort(function (a, b) { return a - b; });
    var p99 = sv.length ? sv[Math.min(sv.length - 1, Math.floor(sv.length * 0.99))] : 0;
    var top = Math.max(rmax, p99) * 1.05 || 1;
    var sc = niceScale(0, top, 7), cut = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (typeof v === 'number' && v > sc.max) cut++; }); });
    return { max: sc.max, cut: cut };
  }
  var api = { autoYMax: autoYMax, parseMoenvJson: parseMoenvJson, fetchMonth: fetchMonth, apiUrl: apiUrl, DEFAULT_API: DEFAULT_API, DEFAULT_KEY: DEFAULT_KEY, nextMonth: nextMonth, parseMoenvCsv: parseMoenvCsv, mergeMoenv: mergeMoenv, moenvMonths: moenvMonths, moenvDaily: moenvDaily, drawTrend: drawTrend, buildTrendWorkbook: buildTrendWorkbook, lineChartXml: lineChartXml, PALETTE: PALETTE, REF_COLOR: REF_COLOR, splitCsv: splitCsv };
  root.EnvTrend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
