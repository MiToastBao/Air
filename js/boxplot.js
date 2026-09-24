/*
 * 盒鬚圖：統計（與 Excel 盒鬚圖相同：四分位數「包含中位數」QUARTILE.INC、鬚到 1.5 倍四分位距內最遠的資料點）、
 * 高解析度圖片（canvas，圖上不寫任何統計數字）、可編輯的 Excel（原生盒鬚圖 chartEx）。
 */
(function (root) {
  'use strict';
  var Core = root.EnvCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  // 盒鬚圖的測項（風速、風向、雨量不畫）
  var BOX_FIELDS = [
    { f: 'TMP', sheet: '溫度', title: '溫度', y: '溫度（℃）' },
    { f: 'HUM', sheet: '濕度', title: '相對濕度', y: '相對濕度（%）' },
    { f: 'PM10', sheet: 'PM10', title: 'PM10', y: 'PM10（μg/m³）' },
    { f: 'PM25', sheet: 'PM2.5', title: 'PM2.5', y: 'PM2.5（μg/m³）' },
    { f: 'TVOC', sheet: 'TVOC', title: 'TVOC', y: 'TVOC（ppb）' },
    { f: 'LEQ', period: 'DAY', sheet: '噪音Leq日間', title: '噪音 Leq 日間', y: 'Leq 日間（dB(A)）' },
    { f: 'LEQ', period: 'EVE', sheet: '噪音Leq晚間', title: '噪音 Leq 晚間', y: 'Leq 晚間（dB(A)）' },
    { f: 'LEQ', period: 'NIGHT', sheet: '噪音Leq夜間', title: '噪音 Leq 夜間', y: 'Leq 夜間（dB(A)）' }
  ];
  /** 噪音時段設定 → 每個整點屬於哪個時段（逐時 Leq 依整點歸入日／晚／夜） */
  function hourPeriods(cfg) {
    var map = {};
    ['DAY', 'EVE', 'NIGHT'].forEach(function (k) {
      (cfg[k] || []).forEach(function (g) { for (var o = g.fd * 24 + g.fh; o < g.td * 24 + g.th; o++) map[o % 24] = k; });
    });
    return map;
  }

  /** QUARTILE.INC：位置 (n-1)p，線性內插；sorted 需由小到大 */
  function quantileInc(sorted, p) {
    var n = sorted.length;
    if (!n) return null;
    var h = (n - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }

  /** 一組數值的盒鬚圖統計 */
  function boxStats(values) {
    var s = values.slice().sort(function (a, b) { return a - b; });
    var n = s.length;
    if (!n) return null;
    var q1 = quantileInc(s, 0.25), med = quantileInc(s, 0.5), q3 = quantileInc(s, 0.75), iqr = q3 - q1;
    var lf = q1 - 1.5 * iqr, uf = q3 + 1.5 * iqr, lo = null, hi = null, out = [], sum = 0;
    for (var i = 0; i < n; i++) {
      var v = s[i]; sum += v;
      if (v >= lf - 1e-9 && v <= uf + 1e-9) { if (lo === null) lo = v; hi = v; } else out.push(v);
    }
    return { n: n, min: s[0], max: s[n - 1], q1: q1, med: med, q3: q3, lo: lo, hi: hi, mean: sum / n, outliers: out };
  }

  /** 漂亮的刻度 */
  function niceScale(min, max, want) {
    want = want || 6;
    if (!(isFinite(min) && isFinite(max))) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
    if (min === max) { var d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    var raw = (max - min) / Math.max(1, want - 1), mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    var step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
    var a = Math.floor(min / step + 1e-9) * step, b = Math.ceil(max / step - 1e-9) * step, ticks = [];
    for (var t = a; t <= b + step * 1e-6; t += step) ticks.push(Math.round(t / step) * step);
    return { min: a, max: b, step: step, ticks: ticks };
  }
  function fmtTick(v, step) {
    var dec = 0; while (dec < 4 && Math.abs(Math.round(step * Math.pow(10, dec)) - step * Math.pow(10, dec)) > 1e-6) dec++;
    return v.toFixed(dec);
  }

  /**
   * 畫盒鬚圖。spec = { title, xTitle, yTitle, groups:[{name, stats}], yMin, yMax, showTitle, showYNums, showOutliers }
   * 回傳 {width, height}（邏輯尺寸）。scale 決定解析度（下載用 3 倍）。
   * 所有文字先量尺寸再排版：標籤放不下就斜 45°，邊界依文字大小自動加寬，不會重疊或被裁切。
   */
  var FONT = '"Microsoft JhengHei","微軟正黑體","PingFang TC","Noto Sans CJK TC","Noto Sans TC",sans-serif';
  function layout(ctx, spec) {
    var n = spec.groups.length;
    var fs = { title: 22, axis: 17, tick: 15, label: 15 };
    var slot = n <= 6 ? 110 : n <= 12 ? 80 : 64;
    var plotW = Math.max(520, n * slot);
    ctx.font = fs.label + 'px ' + FONT;
    var lw = spec.groups.map(function (g) { return ctx.measureText(g.name).width; });
    var maxLw = lw.reduce(function (a, b) { return Math.max(a, b); }, 0);
    var rotate = maxLw > slot - 10;
    var cos = Math.SQRT1_2;
    // 刻度
    var lo = Infinity, hi = -Infinity;
    spec.groups.forEach(function (g) {
      var s = g.stats; if (!s) return;
      var a = spec.showOutliers ? s.min : s.lo, b = spec.showOutliers ? s.max : s.hi;
      if (a < lo) lo = a; if (b > hi) hi = b;
    });
    var ymin = typeof spec.yMin === 'number' ? spec.yMin : lo, ymax = typeof spec.yMax === 'number' ? spec.yMax : hi;
    var sc = niceScale(ymin, ymax, 7);
    if (typeof spec.yMin === 'number') sc.min = spec.yMin;
    if (typeof spec.yMax === 'number') sc.max = spec.yMax;
    sc.ticks = sc.ticks.filter(function (t) { return t >= sc.min - 1e-9 && t <= sc.max + 1e-9; });
    ctx.font = fs.tick + 'px ' + FONT;
    var tickW = spec.showYNums ? sc.ticks.reduce(function (a, t) { return Math.max(a, ctx.measureText(fmtTick(t, sc.step)).width); }, 0) : 0;
    var pad = 24;
    var left = pad + fs.axis * 1.3 + 14 + (spec.showYNums ? tickW + 10 : 0) + 6;
    var labH = rotate ? maxLw * cos + fs.label * cos + 6 : fs.label * 1.3;
    // 第一個標籤斜放時會往左伸出去，左邊界要夠
    if (rotate) { var need = maxLw * cos + 4 - slot / 2; if (need > left - pad) left = pad + need; }
    var top = pad + (spec.showTitle ? fs.title * 1.5 + 8 : 6);
    var bottom = pad + 10 + labH + 12 + fs.axis * 1.3;
    var right = pad + 12;
    return { fs: fs, slot: slot, plotW: plotW, plotH: 420, rotate: rotate, lw: lw, sc: sc, left: left, top: top, bottom: bottom, right: right,
      width: Math.ceil(left + plotW + right), height: Math.ceil(top + 420 + bottom) };
  }
  function drawBoxPlot(canvas, spec, scale) {
    scale = scale || 1;
    var ctx = canvas.getContext('2d');
    var L = layout(ctx, spec);
    canvas.width = Math.ceil(L.width * scale); canvas.height = Math.ceil(L.height * scale);
    ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, L.width, L.height);
    var x0 = L.left, y0 = L.top, W = L.plotW, H = L.plotH, sc = L.sc;
    var Y = function (v) { return y0 + H - (v - sc.min) / (sc.max - sc.min) * H; };
    ctx.textBaseline = 'middle';
    // 標題
    if (spec.showTitle) {
      ctx.fillStyle = '#000'; ctx.font = 'bold ' + L.fs.title + 'px ' + FONT; ctx.textAlign = 'center';
      ctx.fillText(spec.title, x0 + W / 2, 24 + L.fs.title * 0.7);
    }
    // 格線與刻度
    ctx.font = L.fs.tick + 'px ' + FONT;
    sc.ticks.forEach(function (t) {
      var y = Math.round(Y(t)) + 0.5;
      ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + W, y); ctx.stroke();
      if (spec.showYNums) { ctx.fillStyle = '#000'; ctx.textAlign = 'right'; ctx.fillText(fmtTick(t, sc.step), x0 - 10, y); }
    });
    // 繪圖區外框
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + H); ctx.lineTo(x0 + W, y0 + H); ctx.stroke();
    // 盒鬚
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 1, W, H + 2); ctx.clip();
    var n = spec.groups.length, slot = W / Math.max(1, n), bw = Math.min(48, slot * 0.55);
    spec.groups.forEach(function (g, i) {
      var s = g.stats; if (!s) return;
      var cx = x0 + slot * (i + 0.5);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1.4;
      // 鬚
      ctx.beginPath();
      ctx.moveTo(cx, Y(s.hi)); ctx.lineTo(cx, Y(s.q3)); ctx.moveTo(cx, Y(s.q1)); ctx.lineTo(cx, Y(s.lo));
      ctx.moveTo(cx - bw / 4, Y(s.hi)); ctx.lineTo(cx + bw / 4, Y(s.hi)); ctx.moveTo(cx - bw / 4, Y(s.lo)); ctx.lineTo(cx + bw / 4, Y(s.lo));
      ctx.stroke();
      // 盒
      var yt = Y(s.q3), yb = Y(s.q1);
      ctx.fillStyle = '#bdd7ee'; ctx.fillRect(cx - bw / 2, yt, bw, Math.max(1, yb - yt));
      ctx.strokeRect(cx - bw / 2, yt, bw, Math.max(1, yb - yt));
      // 中位數
      ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(cx - bw / 2, Y(s.med)); ctx.lineTo(cx + bw / 2, Y(s.med)); ctx.stroke();
      if (spec.showOutliers) {
        ctx.lineWidth = 1;
        s.outliers.forEach(function (v) { ctx.beginPath(); ctx.arc(cx, Y(v), 2.6, 0, Math.PI * 2); ctx.stroke(); });
      }
    });
    ctx.restore();
    // X 軸標籤（感測器名稱）
    ctx.fillStyle = '#000'; ctx.font = L.fs.label + 'px ' + FONT;
    spec.groups.forEach(function (g, i) {
      var cx = x0 + slot * (i + 0.5), y = y0 + H + 10;
      if (L.rotate) {
        ctx.save(); ctx.translate(cx, y + 2); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(g.name, 0, 0); ctx.restore();
      } else { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(g.name, cx, y); }
    });
    // 軸標題
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = 'bold ' + L.fs.axis + 'px ' + FONT;
    ctx.fillText(spec.xTitle, x0 + W / 2, L.height - 24 - L.fs.axis * 0.65);
    ctx.save(); ctx.translate(24 + L.fs.axis * 0.65, y0 + H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.yTitle, 0, 0); ctx.restore();
    return { width: L.width, height: L.height };
  }

  // ---------------- Excel（原生盒鬚圖） ----------------
  function xesc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function colName(c) { var s = ''; c++; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function qs(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }
  var FONT_X = '<a:latin typeface="微軟正黑體" panose="020B0604030504040204" pitchFamily="34" charset="-120"/><a:ea typeface="微軟正黑體" panose="020B0604030504040204" pitchFamily="34" charset="-120"/>';
  function rich(text, sz, bold, rot) {
    return '<cx:rich><a:bodyPr rot="' + (rot || 0) + '" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr algn="ctr"><a:defRPr sz="' + sz + '" b="' + (bold ? 1 : 0) + '"><a:solidFill><a:sysClr val="windowText" lastClr="000000"/></a:solidFill>' + FONT_X + '</a:defRPr></a:pPr><a:r><a:rPr lang="zh-TW" altLang="en-US" sz="' + sz + '" b="' + (bold ? 1 : 0) + '"><a:solidFill><a:sysClr val="windowText" lastClr="000000"/></a:solidFill>' + FONT_X + '</a:rPr><a:t>' + xesc(text) + '</a:t></a:r></a:p></cx:rich>';
  }
  function txPr(sz, rot) {
    return '<cx:txPr><a:bodyPr rot="' + (rot === undefined ? -60000000 : rot) + '" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="' + sz + '" b="0"><a:solidFill><a:sysClr val="windowText" lastClr="000000"/></a:solidFill>' + FONT_X + '</a:defRPr></a:pPr><a:endParaRPr lang="zh-TW"/></a:p></cx:txPr>';
  }
  /** chartEx XML：單一數列，類別＝感測器名稱，同名的列合成一個盒 */
  function chartExXml(o) {
    var val = '<cx:valScaling' + (typeof o.yMin === 'number' ? ' min="' + o.yMin + '"' : '') + (typeof o.yMax === 'number' ? ' max="' + o.yMax + '"' : '') + '/>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cx:chartSpace xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">' +
      '<cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>' + o.catName + '</cx:f></cx:strDim><cx:numDim type="val"><cx:f>' + o.valName + '</cx:f></cx:numDim></cx:data></cx:chartData>' +
      '<cx:chart>' + (o.showTitle ? '<cx:title pos="t" align="ctr" overlay="0"><cx:tx>' + rich(o.title, 1400, true) + '</cx:tx></cx:title>' : '') +
      '<cx:plotArea><cx:plotAreaRegion><cx:series layoutId="boxWhisker" uniqueId="{0000000' + (o.idx % 10) + '-B0B0-4C1D-9E2A-0000000000' + (10 + o.idx) + '}">' +
      '<cx:tx><cx:txData><cx:f>' + o.txName + '</cx:f><cx:v>' + xesc(o.title) + '</cx:v></cx:txData></cx:tx>' +
      '<cx:spPr><a:solidFill><a:srgbClr val="BDD7EE"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></cx:spPr>' +
      '<cx:dataId val="0"/><cx:layoutPr><cx:visibility meanLine="0" meanMarker="0" nonoutliers="0" outliers="' + (o.showOutliers ? 1 : 0) + '"/><cx:statistics quartileMethod="inclusive"/></cx:layoutPr></cx:series></cx:plotAreaRegion>' +
      '<cx:axis id="0"><cx:catScaling gapWidth="1"/><cx:title><cx:tx>' + rich(o.xTitle, 1100, true) + '</cx:tx></cx:title><cx:tickLabels/>' + txPr(1000) + '</cx:axis>' +
      '<cx:axis id="1">' + val + '<cx:title><cx:tx>' + rich(o.yTitle, 1100, true, -5400000) + '</cx:tx></cx:title><cx:majorGridlines/>' + (o.showYNums ? '<cx:tickLabels/>' : '') + txPr(1000) + '</cx:axis>' +
      '</cx:plotArea></cx:chart></cx:chartSpace>';
  }
  function drawingXml(o) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + o.row + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>' + o.cols + '</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + (o.row + o.rows) + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1"><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="' + xesc(o.name) + '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>' +
      '<mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="3600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-TW" altLang="en-US" sz="1100"/><a:t>此圖表（盒鬚圖）需要 Excel 2016 以上或 Microsoft 365 才能顯示。</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
  }
  var COLORS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" meth="cycle" id="10"><a:schemeClr val="accent1"/><a:schemeClr val="accent2"/><a:schemeClr val="accent3"/><a:schemeClr val="accent4"/><a:schemeClr val="accent5"/><a:schemeClr val="accent6"/><cs:variation/><cs:variation><a:lumMod val="60000"/></cs:variation><cs:variation><a:lumMod val="80000"/><a:lumOff val="20000"/></cs:variation><cs:variation><a:lumMod val="80000"/></cs:variation><cs:variation><a:lumMod val="60000"/><a:lumOff val="40000"/></cs:variation><cs:variation><a:lumMod val="50000"/></cs:variation><cs:variation><a:lumMod val="70000"/><a:lumOff val="30000"/></cs:variation><cs:variation><a:lumMod val="70000"/></cs:variation><cs:variation><a:lumMod val="50000"/><a:lumOff val="50000"/></cs:variation></cs:colorStyle>';

  /**
   * 產生可編輯的 Excel：每個測項一張工作表（左側盒鬚圖、右側資料：感測器｜日期時間｜數值）＋「統計」「說明」。
   * charts = [{field, sheet, title, xTitle, yTitle, yMin, yMax, groups:[{name, rows:[{ts, v}], stats}]}]
   * 回傳 Promise<ArrayBuffer>。ExcelJS 寫資料，JSZip 補上 ExcelJS 不支援的盒鬚圖。
   */
  function buildBoxWorkbook(ExcelJS, JSZip, charts, info, styleXml) {
    var wb = new ExcelJS.Workbook();
    var meta = [];
    charts.forEach(function (c) {
      var ws = wb.addWorksheet(c.sheet);
      var n = c.groups.length;
      var chartCols = Math.max(10, Math.ceil(n * 0.9) + 3), dc = chartCols + 1; // 資料從圖右邊隔一欄開始
      ws.getRow(1).getCell(dc + 1).value = '感測器';
      ws.getRow(1).getCell(dc + 2).value = '日期時間';
      ws.getRow(1).getCell(dc + 3).value = c.title;
      var r = 2;
      c.groups.forEach(function (g) {
        g.rows.forEach(function (x) {
          var row = ws.getRow(r++);
          row.getCell(dc + 1).value = g.name;
          var p = x.ts.split(/[- :]/).map(Number);
          row.getCell(dc + 2).value = new Date(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4] || 0));
          row.getCell(dc + 3).value = x.v;
        });
      });
      ws.getColumn(dc + 2).numFmt = 'yyyy/mm/dd hh:mm';
      Core.xlAutoFit(ws); // 只調有資料的欄；放圖的空白欄不動
      ws.getRow(1).font = { bold: true };
      var last = Math.max(2, r - 1);
      var A = colName(dc), B = colName(dc + 2);
      meta.push({ c: c, cat: qs(c.sheet) + '!$' + A + '$2:$' + A + '$' + last, val: qs(c.sheet) + '!$' + B + '$2:$' + B + '$' + last, tx: qs(c.sheet) + '!$' + B + '$1', cols: chartCols, rows: 26 });
    });
    // 統計
    var st = wb.addWorksheet('統計');
    st.addRow(['測項', '感測器', '有效小時數', '最小值', '第一四分位數(Q1)', '中位數', '第三四分位數(Q3)', '最大值', '下鬚', '上鬚', '平均值', '離群值個數']);
    charts.forEach(function (c) {
      c.groups.forEach(function (g) {
        var s = g.stats;
        st.addRow([c.title, g.name, s ? s.n : 0].concat(s ? [s.min, s.q1, s.med, s.q3, s.max, s.lo, s.hi, s.mean, s.outliers.length] : []));
      });
    });
    st.getRow(1).font = { bold: true };
    for (var k = 4; k <= 11; k++) st.getColumn(k).numFmt = '0.00';
    Core.xlAutoFit(st);
    var ex = wb.addWorksheet('說明');
    (info || []).forEach(function (t) { ex.addRow([t]); });
    Core.xlWrapCol(ex, 1, 110); Core.xlFitHeights(ex); // 說明：固定欄寬、換行

    return wb.xlsx.writeBuffer().then(function (buf) { return JSZip.loadAsync(buf); }).then(function (zip) {
      return Promise.all([zip.file('xl/workbook.xml').async('string'), zip.file('xl/_rels/workbook.xml.rels').async('string'), zip.file('[Content_Types].xml').async('string')]).then(function (a) {
        var wbx = a[0], rels = a[1], ct = a[2];
        // 工作表名稱 → 檔案
        var rid = {}; rels.replace(/<Relationship\b[^>]*>/g, function (t) { var i = /Id="([^"]+)"/.exec(t), g = /Target="([^"]+)"/.exec(t); if (i && g) rid[i[1]] = g[1].replace(/^\/?xl\//, ''); return t; });
        var sheetFile = {}; wbx.replace(/<sheet\b[^>]*>/g, function (t) { var nm = /name="([^"]+)"/.exec(t)[1], r = /r:id="([^"]+)"/.exec(t)[1]; sheetFile[nm.replace(/&amp;/g, '&')] = rid[r]; return t; });
        var names = '', jobs = [];
        meta.forEach(function (m, i) {
          var k = i + 1, base = i * 3;
          var nCat = '_xlchart.v1.' + base, nVal = '_xlchart.v1.' + (base + 1), nTx = '_xlchart.v1.' + (base + 2);
          names += '<definedName name="' + nCat + '" hidden="1">' + xesc(m.cat) + '</definedName><definedName name="' + nVal + '" hidden="1">' + xesc(m.val) + '</definedName><definedName name="' + nTx + '" hidden="1">' + xesc(m.tx) + '</definedName>';
          zip.file('xl/charts/chartEx' + k + '.xml', chartExXml({ idx: k, catName: nCat, valName: nVal, txName: nTx, title: m.c.title, xTitle: m.c.xTitle, yTitle: m.c.yTitle, yMin: m.c.yMin, yMax: m.c.yMax, showTitle: m.c.showTitle, showYNums: m.c.showYNums, showOutliers: m.c.showOutliers }));
          zip.file('xl/charts/style' + k + '.xml', styleXml);
          zip.file('xl/charts/colors' + k + '.xml', COLORS_XML);
          zip.file('xl/charts/_rels/chartEx' + k + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2011/relationships/chartColorStyle" Target="colors' + k + '.xml"/><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartStyle" Target="style' + k + '.xml"/></Relationships>');
          zip.file('xl/drawings/drawing' + k + '.xml', drawingXml({ row: 0, rows: m.rows, cols: m.cols, name: m.c.title + ' 盒鬚圖' }));
          zip.file('xl/drawings/_rels/drawing' + k + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2014/relationships/chartEx" Target="../charts/chartEx' + k + '.xml"/></Relationships>');
          ct = ct.replace('</Types>', '<Override PartName="/xl/drawings/drawing' + k + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chartEx' + k + '.xml" ContentType="application/vnd.ms-office.chartex+xml"/><Override PartName="/xl/charts/style' + k + '.xml" ContentType="application/vnd.ms-office.chartstyle+xml"/><Override PartName="/xl/charts/colors' + k + '.xml" ContentType="application/vnd.ms-office.chartcolorstyle+xml"/></Types>');
          var sf = 'xl/' + sheetFile[m.c.sheet], sr = sf.replace(/worksheets\/(sheet\d+\.xml)$/, 'worksheets/_rels/$1.rels');
          jobs.push(zip.file(sf).async('string').then(function (x) {
            var relsP = zip.file(sr) ? zip.file(sr).async('string') : Promise.resolve('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
            return relsP.then(function (rx) {
              var id = 'rIdBox' + k;
              rx = rx.replace('</Relationships>', '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing' + k + '.xml"/></Relationships>');
              var tag = '<drawing r:id="' + id + '"/>';
              if (x.indexOf('xmlns:r=') < 0) x = x.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
              var at = x.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
              x = at >= 0 ? x.slice(0, at) + tag + x.slice(at) : x.replace('</worksheet>', tag + '</worksheet>');
              zip.file(sf, x); zip.file(sr, rx);
            });
          }));
        });
        // 定義名稱依名稱排序（和 Excel 自己存檔的順序一樣）
        var m0 = /<definedNames>([\s\S]*?)<\/definedNames>/.exec(wbx), all = (m0 ? m0[1] : '') + names;
        var list = all.match(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g) || [];
        list.sort(function (a, b) { var x = /name="([^"]+)"/.exec(a)[1], y = /name="([^"]+)"/.exec(b)[1]; return x < y ? -1 : x > y ? 1 : 0; });
        var dn = '<definedNames>' + list.join('') + '</definedNames>';
        wbx = m0 ? wbx.replace(m0[0], dn) : wbx.replace('</sheets>', '</sheets>' + dn);
        zip.file('xl/workbook.xml', wbx); zip.file('[Content_Types].xml', ct);
        return Promise.all(jobs).then(function () { return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }); });
      });
    });
  }

  var api = { BOX_FIELDS: BOX_FIELDS, hourPeriods: hourPeriods, quantileInc: quantileInc, boxStats: boxStats, niceScale: niceScale, fmtTick: fmtTick, drawBoxPlot: drawBoxPlot, layout: layout, chartExXml: chartExXml, buildBoxWorkbook: buildBoxWorkbook, colName: colName };
  root.EnvBox = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
