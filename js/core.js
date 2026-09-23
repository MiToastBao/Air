/*
 * 微型感測器數據系統 — 計算核心（純函式，不碰畫面與儲存）
 * 同一份檔案同時給瀏覽器（window.EnvCore）與 Node 測試（module.exports）使用。
 *
 * 計算口徑（使用者 2026-09-23 裁示）：
 *  - 負值（-9999 或其他負數）、空白、文字 = 儀器異常，屬非有效資料，不計入、也不當 0。
 *  - 四捨五入一律為「一般四捨五入」到小數 1 位（不採 Access 的銀行家進位）。
 *  - 空品各項：當日有效值算術平均。雨量：當日有效值加總（日累積雨量）。
 *  - 最頻風向：風向角度換算 16 方位文字（每方位 22.5°，北 = 348.75°～11.25°），
 *    只採計同一小時風速有效且 ≥ 0.3 m/s 者，取當日出現次數最多的方位；
 *    若 N 個方位並列最多，N 個方位全部列出（北起順時針，以「、」分隔），只寫方位（不加「風」字），例：「北、西北」。
 *  - 噪音：日 06–20 時、晚 20–22 時、夜 = 同一日曆日的 00–06 時加 22–24 時；
 *    各時段以能量平均：10·log10(平均(10^(L/10)))。
 *  - PM10、PM2.5 測值為 0 也視為異常（沿用 Access 的既有做法，可在設定中關閉）。
 *  - 同一小時 PM2.5 > PM10（常識性錯誤）：PM10、PM2.5 兩者都不計（可在設定中關閉）。
 *  - 不設最低有效時數門檻，改以備註欄提醒有效資料時數。
 */
(function (root) {
  'use strict';

  var AIR_FIELDS = ['TMP', 'HUM', 'PM10', 'PM25', 'TVOC', 'WS', 'RA', 'WD'];
  var NOISE_FIELDS = ['LEQ', 'LMAX'];
  var FIELD_LABEL = {
    TMP: 'TMP', HUM: 'HUM', PM10: 'PM10', PM25: 'PM2.5', TVOC: 'TVOC',
    WS: 'WS', WD: 'WD', RA: '雨量', LEQ: 'Leq', LMAX: 'Leq(max)'
  };
  var DIR16 = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東',
    '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];

  var SCALE = 1000000; // 原始值以 10^-6 為單位轉成整數後加總，避免浮點誤差

  /** 有效值：有限數字且 >= 0；其餘（負值、空白、文字、NaN）一律 null */
  function validValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      var s = v.trim();
      if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
      v = Number(s);
    }
    if (typeof v !== 'number' || !isFinite(v)) return null;
    if (v < 0) return null;
    return v;
  }

  /** 一般四捨五入到 1 位小數；x 為非負浮點數（噪音 dB 用） */
  function roundHalfUp1(x) {
    if (x === null || x === undefined || !isFinite(x)) return null;
    var y = x * 10;
    // 抵銷浮點表示誤差（例如 52.25 存成 52.249999…）
    var r = Math.floor(y + 0.5 + 1e-9 * Math.max(1, Math.abs(y)));
    return r / 10;
  }

  /** 以整數精確計算平均並一般四捨五入到 1 位小數 */
  function exactMean1(values) {
    if (!values.length) return null;
    var S = 0;
    for (var i = 0; i < values.length; i++) S += Math.round(values[i] * SCALE);
    var D = values.length * SCALE;
    // round(S*10/D) 半數進位：floor((20S + D) / 2D)，S 與 D 皆為整數且 S >= 0
    return Math.floor((20 * S + D) / (2 * D)) / 10;
  }

  function exactSum1(values) {
    if (!values.length) return null;
    var S = 0;
    for (var i = 0; i < values.length; i++) S += Math.round(values[i] * SCALE);
    // S/SCALE 四捨五入到 1 位：floor((20S + SCALE) / 2SCALE)
    return Math.floor((20 * S + SCALE) / (2 * SCALE)) / 10;
  }

  /** 風向度數 → 16 方位索引（0 = 北） */
  function dirIndex(deg) {
    var d = deg % 360;
    return Math.floor((d + 11.25) / 22.5) % 16;
  }

  /** 當日最頻風向；同時有 N 個方位並列最多時，N 個方位全部列出（北起順時針，以「、」分隔），例「北、西北」 */
  function modeDirection(degs) {
    if (!degs.length) return null;
    var cnt = new Array(16).fill(0);
    for (var i = 0; i < degs.length; i++) cnt[dirIndex(degs[i])]++;
    var mx = Math.max.apply(null, cnt);
    var out = [];
    for (var k = 0; k < 16; k++) if (cnt[k] === mx) out.push(DIR16[k]);
    return out.join('、');
  }

  var CALM_TEXT = '<0.3'; // 全天靜風時最頻風向欄的文字
  var CALM_WS = 0.3; // 風速 < 0.3 m/s 的那一小時，風向不列入最頻風向（剛好 0.3 要計入）

  /** 取當日可用於最頻風向的風向值：風向有效，且同一小時風速有效並 ≥ 0.3 */
  function windDirs(rows, hasWS) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var wd = validValue(rows[i].v.WD);
      if (wd === null) continue;
      if (hasWS) {
        var ws = validValue(rows[i].v.WS);
        if (ws === null || ws < CALM_WS) continue;
      }
      out.push(wd);
    }
    return out;
  }

  function energyMean1(levels) {
    if (!levels.length) return null;
    var e = 0;
    for (var i = 0; i < levels.length; i++) e += Math.pow(10, levels[i] / 10);
    return roundHalfUp1(10 * Math.log10(e / levels.length));
  }

  /**
   * 噪音日／晚／夜時段設定（每個計畫可自訂）。每個時段可以有 1～3 段，每段：
   *   fd/fh = 起點（fd：0＝當日、1＝翌日；fh：0–23 點），td/th = 終點（不含；th 可到 24）
   * 報表「日期 D」的某時段 = 所有段落 D+fd 日 fh 點 起、到 D+td 日 th 點 前的逐時資料。
   * 出廠預設（與原 Access 相同）：日 06–20、晚 20–22、夜 = 當日 00–06 ＋ 當日 22–24。
   */
  var DEFAULT_NOISE = {
    DAY: [{ fd: 0, fh: 6, td: 0, th: 20 }],
    EVE: [{ fd: 0, fh: 20, td: 0, th: 22 }],
    NIGHT: [{ fd: 0, fh: 0, td: 0, th: 6 }, { fd: 0, fh: 22, td: 0, th: 24 }]
  };
  var NOISE_KEYS = ['DAY', 'EVE', 'NIGHT'];
  var NOISE_LABEL = { DAY: '日間', EVE: '晚間', NIGHT: '夜間' };
  function noiseCfg(c) {
    var out = {};
    NOISE_KEYS.forEach(function (k) {
      var segs = c && Array.isArray(c[k]) && c[k].length ? c[k] : DEFAULT_NOISE[k];
      out[k] = segs.map(function (x) { return { fd: +x.fd || 0, fh: +x.fh || 0, td: +x.td || 0, th: +x.th || 0 }; });
    });
    return out;
  }
  /** 檢查設定：每段起點要早於終點、長度不超過 24 小時；並檢查一天 24 個整點有沒有漏掉或重複 */
  function checkNoise(c) {
    var cfg = noiseCfg(c), errors = [], cover = new Array(24).fill(0), who = [];
    for (var i = 0; i < 24; i++) who.push([]);
    NOISE_KEYS.forEach(function (k) {
      cfg[k].forEach(function (g, j) {
        var a = g.fd * 24 + g.fh, b = g.td * 24 + g.th;
        if (!(g.fh >= 0 && g.fh <= 23 && g.th >= 0 && g.th <= 24 && (g.fd === 0 || g.fd === 1) && (g.td === 0 || g.td === 1))) { errors.push(NOISE_LABEL[k] + '第 ' + (j + 1) + ' 段的時間不正確。'); return; }
        if (b <= a) { errors.push(NOISE_LABEL[k] + '第 ' + (j + 1) + ' 段的結束時間要晚於開始時間。'); return; }
        if (b - a > 24) { errors.push(NOISE_LABEL[k] + '第 ' + (j + 1) + ' 段超過 24 小時。'); return; }
        for (var o = a; o < b; o++) { cover[o % 24]++; who[o % 24].push(NOISE_LABEL[k]); }
      });
    });
    var gap = [], dup = [];
    cover.forEach(function (n, h) { if (n === 0) gap.push(h); else if (n > 1) dup.push(h + ' 點（' + who[h].join('、') + '）'); });
    var warnings = [];
    if (gap.length) warnings.push('以下整點不屬於任何時段，不會列入日晚夜：' + gap.map(function (h) { return h + ' 點'; }).join('、') + '。');
    if (dup.length) warnings.push('以下整點同時屬於兩個時段以上（會重複計入）：' + dup.join('、') + '。');
    return { ok: !errors.length, errors: errors, warnings: warnings };
  }
  /** 文字說明，例：日間 8/1 06:00～8/1 20:00 */
  function describeNoise(c, sample) {
    var cfg = noiseCfg(c), sd = sample || '2026-08-01';
    var md = function (d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); };
    return NOISE_KEYS.map(function (k) {
      return NOISE_LABEL[k] + ' ' + cfg[k].map(function (g) {
        var e = g.th === 24 ? { d: addDays(sd, g.td + 1), h: 0 } : { d: addDays(sd, g.td), h: g.th };
        return md(addDays(sd, g.fd)) + ' ' + pad(g.fh) + ':00～' + md(e.d) + ' ' + pad(e.h) + ':00';
      }).join('＋');
    }).join('；');
  }

  /** 噪音時段：依時（0–23）——出廠預設時段用，保留給舊程式呼叫 */
  function noisePeriod(hour) {
    if (hour >= 6 && hour < 20) return 'DAY';
    if (hour >= 20 && hour < 22) return 'EVE';
    return 'NIGHT';
  }

  // ---------- 日期工具（一律以「牆上時間」字串處理，避免時區位移） ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ts) { return ts.slice(0, 10); } // ts = 'YYYY-MM-DD HH:MM'
  function hourOf(ts) { return Number(ts.slice(11, 13)); }
  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function daysBetween(from, to) {
    var out = [];
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  /** 民國年季別 → 起訖日 */
  function quarterRange(rocYear, q) {
    var y = rocYear + 1911;
    var m1 = (q - 1) * 3 + 1, m3 = m1 + 2;
    var last = new Date(Date.UTC(y, m3, 0)).getUTCDate();
    return { from: y + '-' + pad(m1) + '-01', to: y + '-' + pad(m3) + '-' + pad(last) };
  }
  function toRoc(dateStr) {
    var p = dateStr.split('-');
    return (Number(p[0]) - 1911) + '/' + p[1] + '/' + p[2];
  }

  /**
   * 依感測器、日期彙整。
   * @param sensors  [{id, name, fields:Set|Array(該感測器實際有的欄位), rows:[{ts, v:{欄位:值或null}}]}]
   * @param range    {from:'YYYY-MM-DD', to:'YYYY-MM-DD'}
   * @param opts     {fillMissingDays:boolean, importedMonths:['YYYY-MM'…], zeroInvalid:[欄位]}
   * @return {air:[...], noise:[...]}
   */
  function buildReports(sensors, range, opts) {
    opts = opts || {};
    var fill = opts.fillMissingDays !== false;
    var zeroInvalid = opts.zeroInvalid || ZERO_INVALID;
    var pmRatio = opts.pmRatioInvalid !== false; // 預設開啟：PM2.5 > PM10 的小時兩者都不計
    var ncfg = noiseCfg(opts.noise);
    var air = [], noise = [];
    var sorted = sensors.slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    sorted.forEach(function (s) {
      var fields = Array.isArray(s.fields) ? s.fields : Array.from(s.fields || []);
      var hasAir = fields.some(function (f) { return AIR_FIELDS.indexOf(f) >= 0; });
      var hasNoise = fields.indexOf('LEQ') >= 0;
      var byDay = {};
      s.rows.forEach(function (r) {
        var d = dayKey(r.ts);
        if (d < range.from || d > range.to) return;
        (byDay[d] = byDay[d] || []).push(r);
      });
      var days = Object.keys(byDay).sort();
      if (!days.length) return; // 此區間完全沒有這個感測器的資料就不列
      var tsMap = null;
      var dates = {};
      if (hasNoise) { tsMap = {}; s.rows.forEach(function (r) { tsMap[r.ts] = r; dates[dayKey(r.ts)] = true; }); } // 跨日時段需要用到區間外（翌日）的資料
      var list = days;
      if (fill) {
        // 只補「已匯入月份」裡缺的日子；整個月沒匯入的月份由畫面另行警告，不補空白列
        list = daysBetween(range.from, range.to).filter(function (d) {
          if (byDay[d]) return true;
          if (s.activeFrom && d < s.activeFrom) return false; // 還沒啟用
          if (s.retiredFrom && d >= s.retiredFrom) return false; // 已停用
          return !opts.importedMonths || opts.importedMonths.indexOf(d.slice(0, 7)) >= 0;
        });
      }
      list.forEach(function (d) {
        var rows = byDay[d] || [];
        if (hasAir) air.push(airDay(s, fields, d, rows, zeroInvalid, pmRatio));
        if (hasNoise) noise.push(noiseDay(s, d, tsMap, ncfg, d === list[0], opts.importedMonths, dates));
      });
    });
    return { air: air, noise: noise };
  }

  var ZERO_INVALID = ['PM10', 'PM25']; // 與 Access 相同：PM 測值為 0 視為儀器異常

  function collect(rows, f, zeroInvalid) {
    var out = [];
    var z = zeroInvalid.indexOf(f) >= 0;
    for (var i = 0; i < rows.length; i++) {
      var v = validValue(rows[i].v[f]); // 再檢查一次，儲存層的資料也不信任
      if (v === null) continue;
      if (z && v === 0) continue;
      out.push(v);
    }
    return out;
  }

  /** 原始月報備註欄（逐時）彙整成「伺服器異常×4、連線異常×2」 */
  function rawNotes(rows) {
    var c = {}, order = [];
    rows.forEach(function (r) {
      if (!r.note) return;
      if (!c[r.note]) { c[r.note] = 0; order.push(r.note); }
      c[r.note]++;
    });
    if (!order.length) return '';
    return '；月報備註：' + order.map(function (k) { return k + '×' + c[k]; }).join('、');
  }

  /** 使用者確認「不採用」的欄位小時數 */
  function exclNote(rows, only, key, label) {
    key = key || 'xf'; label = label || '確認不採用';
    var c = {}, order = [];
    rows.forEach(function (r) {
      (r[key] || []).forEach(function (f) {
        if (only && only.indexOf(f) < 0) return;
        if (!c[f]) { c[f] = 0; order.push(f); }
        c[f]++;
      });
    });
    if (!order.length) return '';
    return '；' + label + '：' + order.map(function (f) { return FIELD_LABEL[f] + ' ' + c[f]; }).join('、') + '小時';
  }

  /**
   * PM2.5 不可能大於 PM10（PM2.5 是 PM10 的一部分）。同一小時兩者都有效、且 PM2.5 > PM10 時，
   * 無法判斷是哪一個測錯，兩者都視為異常不計。PM2.5 等於 PM10 仍算有效。
   * 已被判為無效的（負值、空白、PM 為 0、使用者確認不採用）不參與比較。
   */
  function pmRatioClean(rows, zeroInvalid) {
    var n = 0;
    var out = rows.map(function (r) {
      var a = validValue(r.v.PM10), b = validValue(r.v.PM25);
      if (a === 0 && zeroInvalid.indexOf('PM10') >= 0) a = null;
      if (b === 0 && zeroInvalid.indexOf('PM25') >= 0) b = null;
      if (a === null || b === null || !(b > a)) return r;
      n++;
      var v = {}; Object.keys(r.v).forEach(function (k) { v[k] = r.v[k]; });
      v.PM10 = null; v.PM25 = null;
      var o = { ts: r.ts, v: v, pmBad: true };
      if (r.note) o.note = r.note;
      if (r.xf) o.xf = r.xf;
      if (r.mf) o.mf = r.mf;
      if (r.af) o.af = r.af;
      return o;
    });
    return { rows: out, n: n };
  }

  function airDay(s, fields, d, rows, zeroInvalid, pmRatio) {
    var has = function (f) { return fields.indexOf(f) >= 0; };
    var pmNote = '';
    if (pmRatio && has('PM10') && has('PM25')) {
      var pc = pmRatioClean(rows, zeroInvalid);
      rows = pc.rows;
      if (pc.n) pmNote = '；PM2.5大於PM10不計：' + pc.n + '小時';
    }
    var vals = {};
    AIR_FIELDS.forEach(function (f) { vals[f] = has(f) ? collect(rows, f, zeroInvalid) : null; });
    if (has('WD')) vals.WD = windDirs(rows, has('WS'));
    var rec = {
      id: s.id, name: s.name, date: d,
      TMP: vals.TMP ? exactMean1(vals.TMP) : null,
      HUM: vals.HUM ? exactMean1(vals.HUM) : null,
      PM10: vals.PM10 ? exactMean1(vals.PM10) : null,
      PM25: vals.PM25 ? exactMean1(vals.PM25) : null,
      TVOC: vals.TVOC ? exactMean1(vals.TVOC) : null,
      WS: vals.WS ? exactMean1(vals.WS) : null,
      WD: vals.WD ? modeDirection(vals.WD) : null,
      RA: vals.RA ? exactSum1(vals.RA) : null,
      hours: {}, note: '',
      fields: AIR_FIELDS.filter(function (f) { return has(f); }) // 這台有的測項（沒有數值時報表寫「－」，沒有這個測項則留白）
    };
    var used = AIR_FIELDS.filter(function (f) { return has(f) && f !== 'WD'; });
    used.forEach(function (f) { rec.hours[f] = vals[f].length; });
    var note = hoursNote(rows.length, used, rec.hours);
    if (has('WD') && rows.length) {
      rec.hours.WD = vals.WD.length;
      note += '；最頻風向採計' + vals.WD.length + '小時' + (has('WS') ? '（風速≥0.3）' : '（無風速欄，全部採計）');
      // 靜風：有風向、風速都有效的小時，但風速全部 < 0.3 → 最頻風向記為「<0.3」（「－」只代表設備異常或維護沒有測值）
      if (!vals.WD.length && has('WS')) {
        var calm = rows.filter(function (r) { return validValue(r.v.WD) !== null && validValue(r.v.WS) !== null; }).length;
        if (calm) { rec.WD = CALM_TEXT; note += '；全天風速都 < 0.3 m/s（靜風 ' + calm + ' 小時），最頻風向記為「' + CALM_TEXT + '」'; }
      }
    }
    if (rows.length && rows.length < 24) {
      var hs = {}; rows.forEach(function (r) { hs[hourOf(r.ts)] = true; });
      var miss = []; for (var h = 0; h < 24; h++) if (!hs[h]) miss.push({ o: h, d: d, h: h });
      if (miss.length) note += '；月報缺少 ' + hourRanges(miss) + '（' + miss.length + ' 小時）的資料，不列入';
    }
    rec.note = note + pmNote + exclNote(rows, AIR_FIELDS, 'af', '自動判定異常不計') + exclNote(rows, AIR_FIELDS) + exclNote(rows, AIR_FIELDS, 'mf', '手動不採用') + rawNotes(rows);
    return rec;
  }

  function hoursNote(rowCount, used, hours) {
    if (rowCount === 0) return '當日無資料（有效資料0小時）';
    var counts = used.map(function (f) { return hours[f]; });
    var same = counts.every(function (c) { return c === counts[0]; });
    if (same) return '有效資料' + counts[0] + '小時';
    return '有效資料：' + used.map(function (f) { return FIELD_LABEL[f] + ' ' + hours[f]; }).join('、') + '小時';
  }

  function md(d) { return Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)); }
  /** 把連續的小時寫成「9/1 00～06 點」（含頭含尾） */
  function hourRanges(list) {
    var out = [], i = 0;
    while (i < list.length) {
      var j = i;
      while (j + 1 < list.length && list[j + 1].o === list[j].o + 1) j++;
      var a = list[i], b = list[j];
      out.push(a.d === b.d ? md(a.d) + ' ' + pad(a.h) + (a.o === b.o ? ' 點' : '～' + pad(b.h) + ' 點') : md(a.d) + ' ' + pad(a.h) + ' 點～' + md(b.d) + ' ' + pad(b.h) + ' 點');
      i = j + 1;
    }
    return out.join('、');
  }
  function noiseDay(s, d, tsMap, cfg, isFirst, imported, dates) {
    var p = { DAY: [], EVE: [], NIGHT: [] }, used = [], seen = {}, gapNotes = [];
    NOISE_KEYS.forEach(function (k) {
      var expect = 0, missing = [];
      cfg[k].forEach(function (g) {
        for (var o = g.fd * 24 + g.fh; o < g.td * 24 + g.th; o++) {
          var dd = addDays(d, Math.floor(o / 24)), hh = o % 24;
          var ts = dd + ' ' + pad(hh) + ':00';
          expect++;
          var r = tsMap[ts];
          if (!r) { missing.push({ o: o, d: dd, h: hh }); continue; }
          if (!seen[ts]) { seen[ts] = true; used.push(r); }
          var v = validValue(r.v.LEQ);
          if (v !== null) p[k].push(v);
        }
      });
      if (missing.length) {
        var byWhy = {}, order = [];
        missing.forEach(function (x) {
          var w = imported ? (imported.indexOf(x.d.slice(0, 7)) < 0 ? '尚未匯入' : '月報沒有這幾個小時') : (dates[x.d] ? '月報沒有這幾個小時' : '可能是尚未匯入');
          if (!byWhy[w]) { byWhy[w] = []; order.push(w); }
          byWhy[w].push(x);
        });
        gapNotes.push(NOISE_LABEL[k] + '應採計 ' + expect + ' 小時，其中 ' + order.map(function (w) { return hourRanges(byWhy[w]) + ' 沒有資料（' + w + '）'; }).join('、') + '，只採計有資料的 ' + (expect - missing.length) + ' 小時');
      }
    });
    // 期間第一天：本日凌晨屬於「前一天」時段的小時，前一天不在報表內，說明這些小時沒有列入
    var prevNote = '';
    if (isFirst) {
      var prev = addDays(d, -1), hrs = [];
      NOISE_KEYS.forEach(function (k) {
        cfg[k].forEach(function (g) {
          for (var o = g.fd * 24 + g.fh; o < g.td * 24 + g.th; o++) if (o >= 24) hrs.push({ o: o - 24, d: d, h: o - 24, k: k });
        });
      });
      if (hrs.length) {
        hrs.sort(function (a, b) { return a.o - b.o; });
        var ks = []; hrs.forEach(function (x) { if (ks.indexOf(NOISE_LABEL[x.k]) < 0) ks.push(NOISE_LABEL[x.k]); });
        var have = hrs.filter(function (x) { return tsMap[d + ' ' + pad(x.h) + ':00']; }).length;
        prevNote = '；本日 ' + hourRanges(hrs) + ' 屬於前一日（' + md(prev) + '）的' + ks.join('、') + '，前一日不在本報表期間內，這 ' + hrs.length + ' 小時' + (have ? '（有資料 ' + have + ' 小時）' : '') + '沒有列入本報表';
      }
    }
    var total = p.DAY.length + p.EVE.length + p.NIGHT.length;
    var note;
    if (used.length === 0) note = '當日無資料（有效資料0小時）';
    else note = '有效資料' + total + '小時（日' + p.DAY.length + '、晚' + p.EVE.length + '、夜' + p.NIGHT.length + '）';
    return {
      id: s.id, name: s.name, date: d,
      DAY: energyMean1(p.DAY), EVE: energyMean1(p.EVE), NIGHT: energyMean1(p.NIGHT),
      hours: { DAY: p.DAY.length, EVE: p.EVE.length, NIGHT: p.NIGHT.length },
      note: note + (used.length && gapNotes.length ? '；' + gapNotes.join('；') : '') + prevNote +
        exclNote(used, ['LEQ'], 'af', '自動判定異常不計') + exclNote(used, ['LEQ']) + exclNote(used, ['LEQ'], 'mf', '手動不採用') + rawNotes(used)
    };
  }

  var api = {
    AIR_FIELDS: AIR_FIELDS, NOISE_FIELDS: NOISE_FIELDS, FIELD_LABEL: FIELD_LABEL, DIR16: DIR16,
    validValue: validValue, roundHalfUp1: roundHalfUp1, exactMean1: exactMean1, exactSum1: exactSum1,
    dirIndex: dirIndex, modeDirection: modeDirection, energyMean1: energyMean1, noisePeriod: noisePeriod,
    quarterRange: quarterRange, toRoc: toRoc, addDays: addDays, daysBetween: daysBetween,
    buildReports: buildReports, DEFAULT_NOISE: DEFAULT_NOISE, noiseCfg: noiseCfg, checkNoise: checkNoise, describeNoise: describeNoise, NOISE_LABEL: NOISE_LABEL, pmRatioClean: pmRatioClean, pad: pad, ZERO_INVALID: ZERO_INVALID, CALM_WS: CALM_WS, windDirs: windDirs
  };
  root.EnvCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
