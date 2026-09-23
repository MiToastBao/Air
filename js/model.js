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
  function planImport(files, chunks, knownSensors) {
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

    var stats = { added: 0, overwritten: 0, changed: 0, unchanged: 0 };
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
          stats.overwritten++;
          if (sameRow(map[ts], r)) stats.unchanged++; else stats.changed++;
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
        ops.push({ store: 'sensors', type: 'put', value: { id: id, label: s.label, name: known[id].name } });
      }
    });
    return { ok: errors.length === 0, errors: errors, ops: errors.length ? [] : ops, stats: stats, months: months, newSensors: newSensors };
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

  var api = { rowSig: rowSig, reviewItems: reviewItems, applyExclusions: applyExclusions, REVIEW_FIELDS: REVIEW_FIELDS, planImport: planImport, sensorsFromChunks: sensorsFromChunks, coverage: coverage, monthsInRange: monthsInRange, sameRow: sameRow };
  root.EnvModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
