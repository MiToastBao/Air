/*
 * 環境監測季報產生器 — 計算核心（純函式，不碰畫面與儲存）
 * 同一份檔案同時給瀏覽器（window.EnvCore）與 Node 測試（module.exports）使用。
 *
 * 計算口徑（使用者 2026-09-23 裁示）：
 *  - 負值（-9999 或其他負數）、空白、文字 = 儀器異常，屬非有效資料，不計入、也不當 0。
 *  - 四捨五入一律為「一般四捨五入」到小數 1 位（不採 Access 的銀行家進位）。
 *  - 空品各項：當日有效值算術平均。雨量：當日有效值加總（日累積雨量）。
 *  - 最頻風向：風向角度換算 16 方位文字（每方位 22.5°，北 = 348.75°～11.25°），
 *    只採計同一小時風速有效且 > 0.3 m/s 者，取當日出現次數最多的方位；
 *    若 N 個方位並列最多，N 個方位全部列出（北起順時針，以「、」分隔），文字加「風」，例：「北風、西北風」。
 *  - 噪音：日 06–20 時、晚 20–22 時、夜 = 同一日曆日的 00–06 時加 22–24 時；
 *    各時段以能量平均：10·log10(平均(10^(L/10)))。
 *  - PM10、PM2.5 測值為 0 也視為異常（沿用 Access 的既有做法，可在設定中關閉）。
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

  /** 當日最頻風向；同時有 N 個方位並列最多時，N 個方位全部列出（北起順時針，以「、」分隔），例「北風、西北風」 */
  function modeDirection(degs) {
    if (!degs.length) return null;
    var cnt = new Array(16).fill(0);
    for (var i = 0; i < degs.length; i++) cnt[dirIndex(degs[i])]++;
    var mx = Math.max.apply(null, cnt);
    var out = [];
    for (var k = 0; k < 16; k++) if (cnt[k] === mx) out.push(DIR16[k] + '風');
    return out.join('、');
  }

  var CALM_WS = 0.3; // 風速 <= 0.3 m/s 的那一小時，風向不列入最頻風向

  /** 取當日可用於最頻風向的風向值：風向有效，且同一小時風速有效並 > 0.3 */
  function windDirs(rows, hasWS) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var wd = validValue(rows[i].v.WD);
      if (wd === null) continue;
      if (hasWS) {
        var ws = validValue(rows[i].v.WS);
        if (ws === null || !(ws > CALM_WS)) continue;
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

  /** 噪音時段：依時（0–23） */
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
      var list = days;
      if (fill) {
        // 只補「已匯入月份」裡缺的日子；整個月沒匯入的月份由畫面另行警告，不補空白列
        list = daysBetween(range.from, range.to).filter(function (d) {
          return !opts.importedMonths || opts.importedMonths.indexOf(d.slice(0, 7)) >= 0 || byDay[d];
        });
      }
      list.forEach(function (d) {
        var rows = byDay[d] || [];
        if (hasAir) air.push(airDay(s, fields, d, rows, zeroInvalid));
        if (hasNoise) noise.push(noiseDay(s, d, rows));
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
  function exclNote(rows, only) {
    var c = {}, order = [];
    rows.forEach(function (r) {
      (r.xf || []).forEach(function (f) {
        if (only && only.indexOf(f) < 0) return;
        if (!c[f]) { c[f] = 0; order.push(f); }
        c[f]++;
      });
    });
    if (!order.length) return '';
    return '；確認不採用：' + order.map(function (f) { return FIELD_LABEL[f] + ' ' + c[f]; }).join('、') + '小時';
  }

  function airDay(s, fields, d, rows, zeroInvalid) {
    var has = function (f) { return fields.indexOf(f) >= 0; };
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
      hours: {}, note: ''
    };
    var used = AIR_FIELDS.filter(function (f) { return has(f) && f !== 'WD'; });
    used.forEach(function (f) { rec.hours[f] = vals[f].length; });
    var note = hoursNote(rows.length, used, rec.hours);
    if (has('WD') && rows.length) {
      rec.hours.WD = vals.WD.length;
      note += '；最頻風向採計' + vals.WD.length + '小時' + (has('WS') ? '（風速>0.3）' : '（無風速欄，全部採計）');
    }
    rec.note = note + exclNote(rows, AIR_FIELDS) + rawNotes(rows);
    return rec;
  }

  function hoursNote(rowCount, used, hours) {
    if (rowCount === 0) return '當日無資料（有效資料0小時）';
    var counts = used.map(function (f) { return hours[f]; });
    var same = counts.every(function (c) { return c === counts[0]; });
    if (same) return '有效資料' + counts[0] + '小時';
    return '有效資料：' + used.map(function (f) { return FIELD_LABEL[f] + ' ' + hours[f]; }).join('、') + '小時';
  }

  function noiseDay(s, d, rows) {
    var p = { DAY: [], EVE: [], NIGHT: [] };
    rows.forEach(function (r) {
      var v = validValue(r.v.LEQ);
      if (v === null) return;
      p[noisePeriod(hourOf(r.ts))].push(v);
    });
    var total = p.DAY.length + p.EVE.length + p.NIGHT.length;
    var note;
    if (rows.length === 0) note = '當日無資料（有效資料0小時）';
    else note = '有效資料' + total + '小時（日' + p.DAY.length + '、晚' + p.EVE.length + '、夜' + p.NIGHT.length + '）';
    return {
      id: s.id, name: s.name, date: d,
      DAY: energyMean1(p.DAY), EVE: energyMean1(p.EVE), NIGHT: energyMean1(p.NIGHT),
      hours: { DAY: p.DAY.length, EVE: p.EVE.length, NIGHT: p.NIGHT.length },
      note: note + exclNote(rows, ['LEQ']) + rawNotes(rows)
    };
  }

  var api = {
    AIR_FIELDS: AIR_FIELDS, NOISE_FIELDS: NOISE_FIELDS, FIELD_LABEL: FIELD_LABEL, DIR16: DIR16,
    validValue: validValue, roundHalfUp1: roundHalfUp1, exactMean1: exactMean1, exactSum1: exactSum1,
    dirIndex: dirIndex, modeDirection: modeDirection, energyMean1: energyMean1, noisePeriod: noisePeriod,
    quarterRange: quarterRange, toRoc: toRoc, addDays: addDays, daysBetween: daysBetween,
    buildReports: buildReports, pad: pad, ZERO_INVALID: ZERO_INVALID, CALM_WS: CALM_WS, windDirs: windDirs
  };
  root.EnvCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
