/*
 * 匯入計畫與資料整理（純函式，可在 Node 測試）
 */
(function (root) {
  'use strict';

  function sameRow(a, b) {
    if (!a || !b) return false;
    var ka = Object.keys(a.v), kb = Object.keys(b.v);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (a.v[ka[i]] !== b.v[ka[i]]) return false;
    return (a.note || '') === (b.note || '');
  }

  /**
   * 規劃匯入：把這一批（可能多份檔案）解析結果與既有資料比對。
   * @param files     [{fileName, result: parseWorkbook() 的結果}]
   * @param chunks    既有 chunks 陣列
   * @return {ok, errors:[], ops:[], stats:{added, overwritten, changed, unchanged}, months:{YYYY-MM:{sensors:Set}}, newSensors:[]}
   */
  function planImport(files, chunks, knownSensors, opt) {
    opt = opt || {};
    var errors = [];
    var byKey = {};
    chunks.forEach(function (c) { byKey[c.key] = c; });
    var known = {};
    (knownSensors || []).forEach(function (s) { known[s.id] = s; });

    // 同一批裡兩份檔案有同一個感測器、同一個時間 → 擋下
    var owner = {}; // id|ts → fileName
    var incoming = {}; // chunkKey → {id, month, fields:{}, rows:{ts:row}}
    var sensorsSeen = {};
    files.forEach(function (f) {
      if (f.result.blocked) return;
      f.result.sensors.forEach(function (s) {
        sensorsSeen[s.id] = sensorsSeen[s.id] || { id: s.id, label: s.label, defaultName: s.defaultName };
        s.rows.forEach(function (r) {
          var k = s.id + '|' + r.ts;
          if (owner[k] && owner[k] !== f.fileName) {
            errors.push({ id: s.id, ts: r.ts, a: owner[k], b: f.fileName });
            return;
          }
          owner[k] = f.fileName;
          var month = r.ts.slice(0, 7);
          var ck = s.id + '|' + month;
          var inc = incoming[ck] || (incoming[ck] = { id: s.id, month: month, fields: {}, rows: {} });
          s.fields.forEach(function (x) { inc.fields[x] = true; });
          inc.rows[r.ts] = r;
        });
      });
    });

    var stats = { added: 0, overwritten: 0, changed: 0, unchanged: 0, skipped: 0 };
    var dupMonths = {}; // YYYY-MM → {dup, changed, sensors:{}}
    var ops = [], months = {};
    Object.keys(incoming).sort().forEach(function (ck) {
      var inc = incoming[ck];
      var old = byKey[ck];
      var map = {};
      var fields = {};
      if (old) {
        old.rows.forEach(function (r) { map[r.ts] = r; });
        old.fields.forEach(function (x) { fields[x] = true; });
      }
      Object.keys(inc.fields).forEach(function (x) { fields[x] = true; });
      Object.keys(inc.rows).forEach(function (ts) {
        var r = inc.rows[ts];
        if (map[ts]) {
          var same = sameRow(map[ts], r);
          var dm = dupMonths[inc.month] || (dupMonths[inc.month] = { dup: 0, changed: 0, sensors: {} });
          dm.dup++; if (!same) dm.changed++; dm.sensors[inc.id] = true;
          if (opt.skipExisting) { stats.skipped++; return; } // 只匯入新資料：重複的保留原本
          stats.overwritten++;
          if (same) stats.unchanged++; else stats.changed++;
        } else stats.added++;
        map[ts] = r;
      });
      var rows = Object.keys(map).sort().map(function (ts) { return map[ts]; });
      ops.push({ store: 'chunks', type: 'put', value: { key: ck, id: inc.id, month: inc.month, fields: Object.keys(fields), rows: rows } });
      (months[inc.month] = months[inc.month] || {})[inc.id] = true;
    });
    var newSensors = [];
    Object.keys(sensorsSeen).forEach(function (id) {
      var s = sensorsSeen[id];
      if (!known[id]) {
        newSensors.push(id);
        ops.push({ store: 'sensors', type: 'put', value: { id: id, label: s.label, name: s.defaultName || id } });
      } else if (s.label && known[id].label !== s.label) {
        var keep = { id: id, label: s.label, name: known[id].name };
        if (known[id].reportId) keep.reportId = known[id].reportId;
        ops.push({ store: 'sensors', type: 'put', value: keep });
      }
    });
    return { ok: errors.length === 0, errors: errors, ops: errors.length ? [] : ops, stats: stats, months: months, newSensors: newSensors, dupMonths: dupMonths };
  }

  /** 把 chunks 整理成 buildReports 要的感測器清單 */
  function sensorsFromChunks(chunks, sensorMeta, range) {
    var meta = {};
    (sensorMeta || []).forEach(function (s) { meta[s.id] = s; });
    var by = {};
    chunks.forEach(function (c) {
      if (range) {
        var mEnd = c.month + '-31', mStart = c.month + '-01';
        if (mEnd < range.from || mStart > range.to) return;
      }
      var s = by[c.id] || (by[c.id] = { id: c.id, name: (meta[c.id] && meta[c.id].name) || c.id, fields: {}, rows: [] });
      c.fields.forEach(function (f) { s.fields[f] = true; });
      Array.prototype.push.apply(s.rows, c.rows);
    });
    return Object.keys(by).map(function (id) {
      var s = by[id];
      s.fields = Object.keys(s.fields);
      s.rows.sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
      return s;
    });
  }

  /** 已匯入月份 × 感測器 的筆數表 */
  function coverage(chunks) {
    var months = {}, ids = {};
    chunks.forEach(function (c) {
      (months[c.month] = months[c.month] || {})[c.id] = c.rows.length;
      ids[c.id] = true;
    });
    return { months: Object.keys(months).sort(), ids: Object.keys(ids).sort(), table: months };
  }

  function monthsInRange(range) {
    var out = [];
    var y = Number(range.from.slice(0, 4)), m = Number(range.from.slice(5, 7));
    var ey = Number(range.to.slice(0, 4)), em = Number(range.to.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      out.push(y + '-' + (m < 10 ? '0' : '') + m);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // ---------- 備註時段確認 ----------
  var REVIEW_FIELDS = ['TMP', 'HUM', 'PM10', 'PM25', 'TVOC', 'WD', 'WS', 'RA', 'LEQ'];
  function rowSig(r) { return JSON.stringify([r.note || '', REVIEW_FIELDS.map(function (f) { return r.v[f] === undefined ? '-' : r.v[f]; })]); }

  /**
   * 列出月報備註欄有文字、而且還有有效數值的時段（這些需要使用者確認）。
   * 備註有文字但數值本來就全部無效的時段，不需要確認，只計數。
   * @param review  {'id|ts': {sig, exclude:[欄位], at}}  已確認的決定
   */
  function reviewItems(chunks, review) {
    review = review || {};
    var items = [], autoInvalid = 0;
    chunks.forEach(function (c) {
      var fields = c.fields.filter(function (f) { return REVIEW_FIELDS.indexOf(f) >= 0; });
      c.rows.forEach(function (r) {
        if (!r.note) return;
        var validF = fields.filter(function (f) { return r.v[f] !== null && r.v[f] !== undefined; });
        if (!validF.length) { autoInvalid++; return; }
        var key = c.id + '|' + r.ts, sig = rowSig(r), d = review[key];
        var ok = d && d.sig === sig;
        items.push({ key: key, id: c.id, ts: r.ts, note: r.note, v: r.v, fields: fields, validFields: validF,
          status: ok ? 'confirmed' : (d ? 'changed' : 'pending'), exclude: ok ? d.exclude.slice() : [] });
      });
    });
    items.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
    return { items: items, autoInvalid: autoInvalid };
  }

  /** 把已確認「不採用」的欄位設為無效（null），並記在 r.xf 讓備註欄寫出來；簽章不符（月報改過）的決定不套用 */
  function applyExclusions(sensors, review) {
    if (!review) return sensors;
    return sensors.map(function (s) {
      var rows = s.rows.map(function (r) {
        var d = review[s.id + '|' + r.ts];
        if (!d || !d.exclude || !d.exclude.length || d.sig !== rowSig(r)) return r;
        var v = {}; Object.keys(r.v).forEach(function (k) { v[k] = r.v[k]; });
        var xf = [];
        d.exclude.forEach(function (f) { if (v[f] !== null && v[f] !== undefined) { v[f] = null; xf.push(f); } });
        var o = { ts: r.ts, v: v, xf: xf };
        if (r.note) o.note = r.note;
        return o;
      });
      return { id: s.id, name: s.name, fields: s.fields, rows: rows };
    });
  }

  /**
   * 手動不採用時段：[{uid, id, from:'YYYY-MM-DD HH:MM', to, fields:[...], reason}]，起訖都包含。
   * 範圍內該感測器的指定測項設為無效，記在 r.mf，備註欄寫「手動不採用」。
   */
  function applyManual(sensors, list) {
    if (!list || !list.length) return sensors;
    return sensors.map(function (s) {
      var mine = list.filter(function (m) { return m.id === s.id; });
      if (!mine.length) return s;
      var rows = s.rows.map(function (r) {
        var hit = mine.filter(function (m) { return r.ts >= m.from && r.ts <= m.to; });
        if (!hit.length) return r;
        var v = {}; Object.keys(r.v).forEach(function (k) { v[k] = r.v[k]; });
        var mf = [];
        hit.forEach(function (m) { m.fields.forEach(function (f) { if (v[f] !== null && v[f] !== undefined) { v[f] = null; mf.push(f); } }); });
        if (!mf.length) return r;
        var o = { ts: r.ts, v: v, mf: mf };
        if (r.note) o.note = r.note;
        if (r.xf) o.xf = r.xf;
        return o;
      });
      return { id: s.id, name: s.name, fields: s.fields, rows: rows };
    });
  }

  /** 手動時段會影響多少小時、幾個有效數值 */
  function manualImpact(chunks, m) {
    var hours = 0, cells = 0, days = {};
    chunks.forEach(function (c) {
      if (c.id !== m.id) return;
      c.rows.forEach(function (r) {
        if (r.ts < m.from || r.ts > m.to) return;
        hours++; days[r.ts.slice(0, 10)] = true;
        m.fields.forEach(function (f) { if (r.v[f] !== null && r.v[f] !== undefined) cells++; });
      });
    });
    return { hours: hours, cells: cells, days: Object.keys(days).sort() };
  }

  // ---------- 感測器編號／名稱對照表 ----------
  function idText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v).trim();
  }
  /**
   * 讀對照表（本系統範本、使用者自己的表、或以前匯出的報表都可以）。
   * 欄位依表頭文字判斷：「月報…編號／原…編號」＝月報裡的編號；「報表…編號／修正…編號／新…編號」＝報表要顯示的編號；
   * 含「名稱」＝感測器名稱。只有一個編號欄時，報表編號＝月報編號。
   */
  function parseMapping(sheets) {
    var errors = [], warnings = [], map = {}, order = [];
    var found = false;
    sheets.forEach(function (sh) {
      if (found) return;
      for (var r = 0; r < Math.min(10, sh.rows.length); r++) {
        var row = (sh.rows[r] || []).map(function (x) { return x === null || x === undefined ? '' : String(x).trim(); });
        var idCols = [], nameCol = -1;
        row.forEach(function (t, i) { if (/編號/.test(t)) idCols.push(i); else if (/名稱/.test(t) && nameCol < 0) nameCol = i; });
        if (!idCols.length || nameCol < 0) continue;
        found = true;
        var src = idCols[0], rid = -1;
        idCols.forEach(function (i) {
          if (/報表|修正|新/.test(row[i])) rid = i;
          else if (/月報|原/.test(row[i])) src = i;
        });
        if (rid === src) rid = -1;
        if (rid < 0 && idCols.length > 1) rid = idCols.filter(function (i) { return i !== src; })[0];
        for (var k = r + 1; k < sh.rows.length; k++) {
          var line = sh.rows[k] || [];
          var a = idText(line[src]); if (!a) continue;
          var b = rid >= 0 ? idText(line[rid]) : ''; if (!b) b = a;
          var n = idText(line[nameCol]);
          if (!n) { warnings.push('第 ' + (k + 1) + ' 列（' + a + '）名稱是空白，名稱維持不變。'); }
          if (map[a]) {
            if (map[a].rid !== b || (n && map[a].name && map[a].name !== n)) {
              errors.push('月報編號 ' + a + ' 出現多次且內容不同（第 ' + map[a].line + ' 列與第 ' + (k + 1) + ' 列），請只保留一列。');
            }
            continue; // 完全相同的重複列（例如舊報表每天一列）直接略過
          }
          map[a] = { src: a, rid: b, name: n, line: k + 1 }; order.push(a);
        }
        break;
      }
    });
    if (!found) errors.push('找不到表頭。第一列（前 10 列內）要有「感測器編號」與「感測器名稱」欄位，建議用「下載範本」的格式。');
    return { rows: order.map(function (a) { return map[a]; }), errors: errors, warnings: warnings };
  }

  /** 對照表套用前的比對：哪些編號／名稱會改、報表編號有沒有撞號 */
  function planMapping(parsed, sensors, dataIds) {
    var cur = {}; sensors.forEach(function (s) { cur[s.id] = s; });
    var has = {}; (dataIds || []).forEach(function (id) { has[id] = true; });
    var changes = [], same = 0, noData = [], ops = [], errors = parsed.errors.slice();
    var finalRid = {};
    Object.keys(cur).forEach(function (id) { finalRid[id] = cur[id].reportId || id; });
    (dataIds || []).forEach(function (id) { if (!finalRid[id]) finalRid[id] = id; });
    parsed.rows.forEach(function (r) {
      var c = cur[r.src] || { id: r.src, label: '', name: r.src };
      var oldRid = c.reportId || r.src, oldName = c.name;
      var name = r.name || oldName;
      finalRid[r.src] = r.rid;
      if (!has[r.src]) noData.push(r.src);
      if (oldRid === r.rid && oldName === name) { same++; return; }
      changes.push({ src: r.src, oldRid: oldRid, rid: r.rid, oldName: oldName, name: name });
      var v = { id: r.src, label: c.label || '', name: name };
      if (r.rid !== r.src) v.reportId = r.rid;
      ops.push({ store: 'sensors', type: 'put', value: v });
    });
    var byRid = {};
    Object.keys(finalRid).forEach(function (id) { (byRid[finalRid[id]] = byRid[finalRid[id]] || []).push(id); });
    Object.keys(byRid).forEach(function (rid) {
      if (byRid[rid].length > 1) errors.push('報表編號 ' + rid + ' 會同時對應到月報編號 ' + byRid[rid].join('、') + '，報表上會分不出來。請修正後再匯入。');
    });
    return { ok: !errors.length, errors: errors, warnings: parsed.warnings, changes: changes, same: same, noData: noData, ops: errors.length ? [] : ops };
  }

  // ---------- 疑似異常時段（匯入後自動判定，預設不採用，逐一確認） ----------
  // 門檻都可以在「④ 產出報表 → 異常判定門檻」修改；以下是出廠預設
  var DEFAULT_AUTO = {
    LEQ999: { on: true, v: 999 },     // Leq ≥ v：儀器錯誤碼
    LEQHIGH: { on: true, v: 120 },    // Leq > v dB
    LEQLOW: { on: true, v: 30 },      // Leq < v dB
    PMCAP: { on: true, v: 990 },      // PM10 或 PM2.5 ≥ v：接近儀器上限
    HUM100: { on: true, v: 100 },     // 濕度 > v %
    TMPRANGE: { on: true, lo: -10, hi: 50 }, // 溫度 < lo 或 > hi ℃
    WSHIGH: { on: true, v: 40 },      // 風速 > v m/s
    WDBAD: { on: true, v: 360 },      // 風向 > v 度
    RAHIGH: { on: true, v: 150 },     // 時雨量 > v mm
    STUCK: { on: true, v: 12 }        // PM10、PM2.5、TVOC、濕度同值連續 ≥ v 小時
  };
  function autoCfg(c) {
    var out = {};
    Object.keys(DEFAULT_AUTO).forEach(function (k) {
      var d = DEFAULT_AUTO[k], u = (c && c[k]) || {};
      out[k] = {}; Object.keys(d).forEach(function (x) { out[k][x] = u[x] !== undefined && u[x] !== null && u[x] !== '' ? u[x] : d[x]; });
    });
    return out;
  }
  function ruleLabel(rule, cfg) {
    var c = cfg[rule];
    switch (rule) {
      case 'LEQ999': return 'Leq ' + c.v + ' 以上，疑似儀器錯誤碼';
      case 'LEQHIGH': return 'Leq 高於 ' + c.v + ' dB，一般環境不太可能出現';
      case 'LEQLOW': return 'Leq 低於 ' + c.v + ' dB，低於一般戶外背景音量';
      case 'PMCAP': return 'PM 數值 ' + c.v + ' 以上，接近儀器量測上限（可能飽和或故障）';
      case 'HUM100': return '相對濕度超過 ' + c.v + '%';
      case 'TMPRANGE': return '溫度低於 ' + c.lo + '℃ 或高於 ' + c.hi + '℃';
      case 'WSHIGH': return '風速高於 ' + c.v + ' m/s';
      case 'WDBAD': return '風向超過 ' + c.v + ' 度（角度不合理）';
      case 'RAHIGH': return '時雨量高於 ' + c.v + ' mm';
      case 'STUCK': return '同一個數值連續 ' + c.v + ' 小時以上沒有變化（可能卡住）';
    }
    return rule;
  }
  var RULE_FIELDS = { LEQ999: ['LEQ'], LEQHIGH: ['LEQ'], LEQLOW: ['LEQ'], PMCAP: ['PM10', 'PM25'], HUM100: ['HUM'], TMPRANGE: ['TMP'], WSHIGH: ['WS'], WDBAD: ['WD'], RAHIGH: ['RA'], STUCK: null };
  var STUCK_FIELDS = ['PM10', 'PM25', 'TVOC', 'HUM'];
  var MERGE_GAP_HOURS = 3;

  function tsHours(ts) { return Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13)) / 3600000; }

  /** 這一格目前是否「有被計算」（已被判為無效、確認不採用、手動不採用的都不算） */
  function counted(r, f, zeroInvalid, pmRatio) {
    var x = r.v[f];
    if (typeof x !== 'number' || !(x >= 0)) return false;
    if (x === 0 && zeroInvalid.indexOf(f) >= 0) return false;
    if (pmRatio && (f === 'PM10' || f === 'PM25')) {
      var a = r.v.PM10, b = r.v.PM25;
      var okA = typeof a === 'number' && a >= 0 && !(a === 0 && zeroInvalid.indexOf('PM10') >= 0);
      var okB = typeof b === 'number' && b >= 0 && !(b === 0 && zeroInvalid.indexOf('PM25') >= 0);
      if (okA && okB && b > a) return false;
    }
    return true;
  }

  /**
   * 找出疑似異常時段。sensors 要先經過 applyExclusions / applyManual。
   * 回傳 [{key, id, rule, label, fields, from, to, hours, hits, hitTs:[...], min, max, noted}]
   * 中間相隔 3 小時以內的合併成一段，但只有「符合的小時」會被自動不採用。
   */
  function detectSuspects(sensors, opts) {
    opts = opts || {};
    var zeroInvalid = opts.zeroInvalid || ['PM10', 'PM25'];
    var pmRatio = opts.pmRatioInvalid !== false;
    var cfg = autoCfg(opts.auto);
    var on = function (k) { return !!cfg[k].on; };
    var out = [];
    sensors.forEach(function (s) {
      var rows = s.rows;
      var hitsByRule = {};
      function add(rule, fkey, r, val) {
        var k = rule + '|' + fkey;
        (hitsByRule[k] = hitsByRule[k] || []).push({ ts: r.ts, val: val, noted: !!r.note });
      }
      var num = function (r, f) { return counted(r, f, zeroInvalid, pmRatio) ? r.v[f] : null; };
      rows.forEach(function (r) {
        var L = num(r, 'LEQ');
        if (L !== null) {
          if (on('LEQ999') && L >= cfg.LEQ999.v) add('LEQ999', 'LEQ', r, L);
          else if (on('LEQHIGH') && L > cfg.LEQHIGH.v) add('LEQHIGH', 'LEQ', r, L);
          else if (on('LEQLOW') && L < cfg.LEQLOW.v) add('LEQLOW', 'LEQ', r, L);
        }
        if (on('PMCAP')) {
          var cap = ['PM10', 'PM25'].filter(function (f) { var x = num(r, f); return x !== null && x >= cfg.PMCAP.v; });
          if (cap.length) add('PMCAP', 'PM', r, Math.max.apply(null, cap.map(function (f) { return r.v[f]; })));
        }
        var h = num(r, 'HUM'); if (on('HUM100') && h !== null && h > cfg.HUM100.v) add('HUM100', 'HUM', r, h);
        var t = typeof r.v.TMP === 'number' ? r.v.TMP : null; // 溫度可能是負值，但負值已在匯入時判為無效
        if (on('TMPRANGE') && t !== null && (t < cfg.TMPRANGE.lo || t > cfg.TMPRANGE.hi)) add('TMPRANGE', 'TMP', r, t);
        var w = num(r, 'WS'); if (on('WSHIGH') && w !== null && w > cfg.WSHIGH.v) add('WSHIGH', 'WS', r, w);
        var d = num(r, 'WD'); if (on('WDBAD') && d !== null && d > cfg.WDBAD.v) add('WDBAD', 'WD', r, d);
        var ra = num(r, 'RA'); if (on('RAHIGH') && ra !== null && ra > cfg.RAHIGH.v) add('RAHIGH', 'RA', r, ra);
      });
      if (on('STUCK')) STUCK_FIELDS.forEach(function (f) {
        var run = [];
        function flush() {
          if (run.length >= cfg.STUCK.v) run.forEach(function (r) { add('STUCK', f, r, r.v[f]); });
          run = [];
        }
        rows.forEach(function (r) {
          var ok = counted(r, f, zeroInvalid, pmRatio);
          var last = run[run.length - 1];
          if (ok && last && r.v[f] === last.v[f] && tsHours(r.ts) - tsHours(last.ts) === 1) run.push(r);
          else { flush(); if (ok) run = [r]; }
        });
        flush();
      });
      Object.keys(hitsByRule).forEach(function (k) {
        var rule = k.split('|')[0], fkey = k.split('|')[1];
        var list = hitsByRule[k].sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
        var g = null;
        function close() {
          if (!g) return;
          var from = g.hits[0].ts, to = g.hits[g.hits.length - 1].ts;
          var hours = rows.filter(function (r) { return r.ts >= from && r.ts <= to; }).length;
          var vals = g.hits.map(function (h) { return h.val; });
          var fields = (RULE_FIELDS[rule] || [fkey]).filter(function (f) { return s.fields.indexOf(f) >= 0; });
          out.push({
            key: s.id + '|' + rule + '|' + fkey + '|' + from + '|' + to, id: s.id, rule: rule, label: ruleLabel(rule, cfg),
            fields: fields, from: from, to: to, hours: hours, hits: g.hits.length, hitTs: g.hits.map(function (h) { return h.ts; }),
            min: Math.min.apply(null, vals), max: Math.max.apply(null, vals), noted: g.hits.filter(function (h) { return h.noted; }).length
          });
          g = null;
        }
        var gap = rule === 'STUCK' ? 1 : MERGE_GAP_HOURS + 1;
        list.forEach(function (h) {
          if (g && tsHours(h.ts) - tsHours(g.hits[g.hits.length - 1].ts) <= gap) g.hits.push(h);
          else { close(); g = { hits: [h] }; }
        });
        close();
      });
    });
    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    return out;
  }

  /**
   * 套用疑似異常的自動不採用：沒被使用者標成「採用（真實數值）」的段，符合的小時該測項設為無效，記在 r.af。
   * decisions = {段key: 'keep' | 'exclude'}，沒有紀錄＝待確認（預設不採用）。
   */
  function applyAuto(sensors, groups, decisions) {
    decisions = decisions || {};
    var hit = {}; // id|ts → [欄位]
    groups.forEach(function (g) {
      if (decisions[g.key] === 'keep') return;
      g.hitTs.forEach(function (ts) {
        var k = g.id + '|' + ts;
        (hit[k] = hit[k] || []);
        g.fields.forEach(function (f) { if (hit[k].indexOf(f) < 0) hit[k].push(f); });
      });
    });
    if (!Object.keys(hit).length) return sensors;
    return sensors.map(function (s) {
      var any = false;
      var rows = s.rows.map(function (r) {
        var fs = hit[s.id + '|' + r.ts];
        if (!fs) return r;
        var v = {}; Object.keys(r.v).forEach(function (k) { v[k] = r.v[k]; });
        var af = [];
        fs.forEach(function (f) { if (v[f] !== null && v[f] !== undefined) { v[f] = null; af.push(f); } });
        if (!af.length) return r;
        any = true;
        var o = { ts: r.ts, v: v, af: af };
        if (r.note) o.note = r.note;
        if (r.xf) o.xf = r.xf;
        if (r.mf) o.mf = r.mf;
        return o;
      });
      return any ? { id: s.id, name: s.name, fields: s.fields, rows: rows } : s;
    });
  }

  /** 完整流程：備註時段確認 → 手動不採用 → 疑似異常自動判定（預設不採用） */
  function processAll(sensors, review, manual, opts, decisions) {
    var base = applyManual(applyExclusions(sensors, review), manual);
    var groups = detectSuspects(base, opts);
    return { sensors: applyAuto(base, groups, decisions), groups: groups, base: base };
  }

  var api = { detectSuspects: detectSuspects, applyAuto: applyAuto, processAll: processAll, DEFAULT_AUTO: DEFAULT_AUTO, autoCfg: autoCfg, ruleLabel: ruleLabel, counted: counted, parseMapping: parseMapping, planMapping: planMapping, applyManual: applyManual, manualImpact: manualImpact, rowSig: rowSig, reviewItems: reviewItems, applyExclusions: applyExclusions, REVIEW_FIELDS: REVIEW_FIELDS, planImport: planImport, sensorsFromChunks: sensorsFromChunks, coverage: coverage, monthsInRange: monthsInRange, sameRow: sameRow };
  root.EnvModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
