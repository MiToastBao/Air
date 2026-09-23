/* 畫面與流程 */
(function () {
  'use strict';
  var Core = window.EnvCore, Parser = window.EnvParser, X = window.EnvXlsx, M = window.EnvModel, Store = window.EnvStore;
  var $ = function (id) { return document.getElementById(id); };
  var state = { chunks: [], sensors: [], meta: {}, loadError: null, busy: false, pending: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rocMonth(ym) { return (Number(ym.slice(0, 4)) - 1911) + '年' + Number(ym.slice(5, 7)) + '月'; }
  function daysInMonth(ym) { return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate(); }
  // 讓畫面先畫出「讀取中」再開始重的工作
  function paint() { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); }

  // ---------------- 分頁 ----------------
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      document.querySelectorAll('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
      if (b.dataset.tab === 'data') renderCoverage();
      if (b.dataset.tab === 'report') updateRangeInfo();
      if (b.dataset.tab === 'names') renderNames();
      if (b.dataset.tab === 'review') renderReview();
    });
  });

  // ---------------- 啟動 ----------------
  $('ver').textContent = '版本 ' + window.ENV_APP_VERSION;
  function fatal(msg) {
    state.loadError = msg;
    $('fatal').hidden = false;
    $('fatal').innerHTML = '<b>無法讀取瀏覽器裡已存的資料：</b>' + esc(msg) +
      '<br>為了避免覆蓋掉原本的資料，匯入、刪除、還原與儲存功能已暫停。請重新整理頁面；若仍然失敗，請改用其他瀏覽器，或先聯絡維護人員。';
    lockWrites();
  }
  function lockWrites() {
    ['fileInput', 'delBtn', 'saveNames', 'restoreFile', 'delYes'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
  }

  function reload() {
    return Store.loadAll().then(function (d) {
      state.chunks = d.chunks; state.sensors = d.sensors;
      state.meta = {}; d.meta.forEach(function (m) { state.meta[m.key] = m.value; });
      applySettings();
      renderCoverage(); fillMonthSelects(); updateRangeInfo(); refreshReviewBadge(); fillReviewFilters();
    });
  }

  Store.open().then(reload).catch(function (e) { fatal(e && e.message ? e.message : String(e)); });

  // ---------------- ① 匯入 ----------------
  var drop = $('drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });
  $('fileInput').addEventListener('change', function (e) {
    var files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) handleFiles(files);
  });

  function setBusy(text, frac) {
    var b = $('importBusy');
    if (text === null) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = esc(text) + '<div class="bar"><i style="width:' + Math.round((frac || 0) * 100) + '%"></i></div>';
  }

  function handleFiles(files) {
    if (state.busy || state.loadError) return;
    state.busy = true;
    $('fileInput').disabled = true;
    $('importPreview').innerHTML = '';
    state.pending = null;
    var results = [];
    var i = 0;
    setBusy('讀取中… 0 / ' + files.length, 0);
    function next() {
      if (i >= files.length) return Promise.resolve();
      var f = files[i];
      setBusy('讀取中… ' + (i + 1) + ' / ' + files.length + '：' + f.name, i / files.length);
      return paint().then(function () { return readOne(f); }).then(function (r) {
        results.push(r); i++; return next();
      });
    }
    next().then(function () {
      setBusy(null);
      var plan = M.planImport(results.filter(function (r) { return r.result; }), state.chunks, state.sensors);
      state.pending = { results: results, plan: plan };
      renderPreview();
    }).catch(function (e) {
      setBusy(null);
      $('importPreview').innerHTML = '<div class="msg err">讀取失敗：' + esc(e.message || e) + '</div>';
    }).then(function () {
      state.busy = false;
      if (!state.loadError) $('fileInput').disabled = false;
    });
  }

  function readOne(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      return Promise.resolve({ fileName: file.name, fatal: '只支援 .xlsx 格式。若是 .xls 或 .csv，請先用 Excel 另存為「Excel 活頁簿 (*.xlsx)」再匯入。' });
    }
    return file.arrayBuffer().then(function (buf) {
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(buf).then(function () {
        var hidden = X.hiddenSheetNames(wb);
        var result = Parser.parseWorkbook(X.workbookToSheets(wb));
        if (hidden.length) result.issues.push({ level: 'info', sheet: '', msg: '隱藏的工作表未讀取：' + hidden.join('、') });
        if (!result.sensors.length && !result.blocked) {
          result.blocked = true;
          result.issues.push({ level: 'error', sheet: '', msg: '這份檔案裡找不到任何可辨識的感測器資料。請確認選的是數據月報。' });
        }
        return { fileName: file.name, result: result };
      });
    }).catch(function (e) {
      return { fileName: file.name, fatal: '無法開啟這份檔案。檔案可能損壞、有密碼保護，或其實不是 .xlsx（例如把 .xls 直接改副檔名）。請用 Excel 開啟後另存為 .xlsx 再匯入。' };
    });
  }

  function renderPreview() {
    var p = state.pending, html = '';
    var importable = 0;
    p.results.forEach(function (r) {
      html += '<div class="card"><div class="file-title">' + esc(r.fileName);
      if (r.fatal) {
        html += '<span class="tag err">不匯入</span></div><div class="msg err">' + esc(r.fatal) + '</div></div>';
        return;
      }
      var res = r.result;
      html += res.blocked ? '<span class="tag err">不匯入</span>' : '<span class="tag ok">可匯入</span>';
      html += '</div>';
      if (!res.blocked) importable++;
      // 月份與天數
      var months = {};
      res.sensors.forEach(function (s) { Object.keys(s.months).forEach(function (m) { months[m] = Math.max(months[m] || 0, s.months[m]); }); });
      var mk = Object.keys(months).sort();
      html += '<div>資料月份：<b>' + (mk.length ? mk.map(rocMonth).join('、') : '（無）') + '</b>，感測器 ' + res.sensors.length + ' 台</div>';
      if (mk.length > 1) html += '<div class="msg warn">這份檔案包含 ' + mk.length + ' 個月份的資料，請確認是否正確。</div>';
      mk.forEach(function (m) {
        var exp = daysInMonth(m) * 24;
        if (months[m] < exp) html += '<div class="msg warn">' + rocMonth(m) + ' 最多只有 ' + months[m] + ' 筆（整月應有 ' + exp + ' 筆），月份可能不完整。</div>';
      });
      // 異常值統計
      var inv = [];
      res.sensors.forEach(function (s) {
        var parts = Object.keys(s.invalid).filter(function (f) { return s.invalid[f] > 0; })
          .map(function (f) { return Core.FIELD_LABEL[f] + ' ' + s.invalid[f]; });
        if (parts.length) inv.push(s.id + '：' + parts.join('、'));
      });
      if (inv.length) {
        html += '<details><summary>非有效資料（負值、空白、文字）筆數：' + inv.length + ' 台感測器有</summary><ul class="issues">' +
          inv.map(function (x) { return '<li class="info">' + esc(x) + '</li>'; }).join('') + '</ul></details>';
      }
      var iss = res.issues.filter(function (x) { return x.level !== 'info'; });
      var info = res.issues.filter(function (x) { return x.level === 'info'; });
      if (iss.length || info.length) {
        html += '<ul class="issues">' + iss.concat(info).map(function (x) {
          return '<li class="' + x.level + '">' + (x.level === 'error' ? '【無法匯入】' : x.level === 'warn' ? '【請確認】' : '') +
            (x.sheet ? '工作表「' + esc(x.sheet) + '」：' : '') + esc(x.msg) + '</li>';
        }).join('') + '</ul>';
      }
      html += '</div>';
    });

    var plan = p.plan;
    html += '<div class="card">';
    if (!plan.ok) {
      html += '<div class="msg err"><b>無法匯入：</b>同一台感測器的同一個時間出現在兩份檔案裡，系統無法判斷哪一份才正確。例如：<ul class="issues">' +
        plan.errors.slice(0, 5).map(function (e) { return '<li>' + esc(e.id) + ' ' + esc(e.ts) + '：「' + esc(e.a) + '」與「' + esc(e.b) + '」</li>'; }).join('') +
        '</ul>請只保留正確的那份檔案，重新選擇後再匯入。</div>';
    } else if (!importable) {
      html += '<div class="msg err">沒有可以匯入的檔案。</div>';
    } else {
      var st = plan.stats;
      html += '<h3>匯入前確認</h3><div class="msg info">將匯入 <b>' + importable + '</b> 份檔案：新增 <b>' + st.added + '</b> 筆、覆蓋既有 <b>' + st.overwritten + '</b> 筆' +
        (st.overwritten ? '（其中內容不同 <b>' + st.changed + '</b> 筆、完全相同 ' + st.unchanged + ' 筆）' : '') + '。</div>';
      if (st.changed) html += '<div class="msg warn">有 ' + st.changed + ' 筆會被新檔案的數值取代，請確認這次匯入的是正確（較新）的月報。</div>';
      if (plan.newSensors.length) html += '<div class="msg info">新的感測器 ' + plan.newSensors.length + ' 台：' + esc(plan.newSensors.join('、')) + '。名稱可在「⑤ 感測器名稱」修改。</div>';
      html += '<div class="row"><button id="confirmImport" class="primary">確認匯入</button><button id="cancelImport">取消</button></div>';
    }
    html += '</div>';
    $('importPreview').innerHTML = html;
    if ($('confirmImport')) $('confirmImport').addEventListener('click', doImport);
    if ($('cancelImport')) $('cancelImport').addEventListener('click', function () { state.pending = null; $('importPreview').innerHTML = ''; });
  }

  function doImport() {
    if (state.loadError || !state.pending || !state.pending.plan.ok) return;
    var btn = $('confirmImport');
    btn.disabled = true; btn.textContent = '寫入中…';
    // 寫入前以最新資料重新規劃，避免兩個分頁同時操作
    Store.loadAll().then(function (d) {
      var plan = M.planImport(state.pending.results.filter(function (r) { return r.result; }), d.chunks, d.sensors);
      if (!plan.ok) throw new Error('資料有重複，請重新選擇檔案。');
      return Store.writeBatch(plan.ops).then(function () { return plan; });
    }).then(function (plan) {
      state.pending = null;
      $('importPreview').innerHTML = '<div class="card"><div class="msg ok">匯入完成：新增 ' + plan.stats.added + ' 筆、覆蓋 ' + plan.stats.overwritten + ' 筆。可到「③ 已匯入資料」確認月份，或到「④ 產出報表」下載。' + reviewHint() + '</div></div>';
      return reload();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '確認匯入';
      $('importPreview').insertAdjacentHTML('beforeend', '<div class="msg err">寫入失敗，這次沒有任何資料被寫入：' + esc(e.message || e) + '</div>');
    });
  }

  // ---------------- ② 已匯入 ----------------
  function sensorName(id) {
    var s = state.sensors.find(function (x) { return x.id === id; });
    return s ? s.name : id;
  }
  function renderCoverage() {
    var cv = M.coverage(state.chunks);
    if (!cv.months.length) { $('coverage').innerHTML = '<p class="hint">尚未匯入任何資料。</p>'; return; }
    var h = '<table><tr><th class="l">月份</th>' + cv.ids.map(function (id) { return '<th title="' + esc(sensorName(id)) + '">' + esc(id) + '<br><span class="hint">' + esc(sensorName(id)) + '</span></th>'; }).join('') + '</tr>';
    cv.months.forEach(function (m) {
      var exp = daysInMonth(m) * 24;
      h += '<tr><td class="l">' + rocMonth(m) + '</td>' + cv.ids.map(function (id) {
        var n = cv.table[m][id];
        if (!n) return '<td class="bad">無</td>';
        return '<td class="' + (n < exp ? 'part' : '') + '">' + n + '</td>';
      }).join('') + '</tr>';
    });
    $('coverage').innerHTML = h + '</table>';
    var sel = $('delMonth');
    sel.innerHTML = cv.months.map(function (m) { return '<option value="' + m + '">' + rocMonth(m) + '</option>'; }).join('');
  }
  $('delBtn').addEventListener('click', function () {
    if (!$('delMonth').value) return;
    $('delMonthLabel').textContent = rocMonth($('delMonth').value);
    $('delConfirm').hidden = false;
  });
  $('delNo').addEventListener('click', function () { $('delConfirm').hidden = true; });
  $('delYes').addEventListener('click', function () {
    if (state.loadError) return;
    var m = $('delMonth').value;
    var ops = state.chunks.filter(function (c) { return c.month === m; }).map(function (c) { return { store: 'chunks', type: 'delete', key: c.key }; });
    Store.writeBatch(ops).then(function () { $('delConfirm').hidden = true; return reload(); })
      .catch(function (e) { alertMsg('刪除失敗：' + (e.message || e)); });
  });
  function alertMsg(t) { $('fatal').hidden = false; $('fatal').textContent = t; }

  // ---------------- ③ 報表 ----------------
  function allMonths() { return M.coverage(state.chunks).months; }
  function fillMonthSelects() {
    var ms = allMonths();
    var opts = ms.map(function (m) { return '<option value="' + m + '">' + rocMonth(m) + '</option>'; }).join('');
    $('mFrom').innerHTML = opts; $('mTo').innerHTML = opts;
    if (ms.length) {
      $('mFrom').value = ms[Math.max(0, ms.length - 3)]; $('mTo').value = ms[ms.length - 1];
      var last = ms[ms.length - 1];
      if (!$('qYear').value) {
        $('qYear').value = Number(last.slice(0, 4)) - 1911;
        $('qNum').value = String(Math.ceil(Number(last.slice(5, 7)) / 3));
      }
      if (!$('dFrom').value) { $('dFrom').value = ms[0] + '-01'; $('dTo').value = last + '-' + daysInMonth(last); }
    } else if (!$('qYear').value) {
      var now = new Date();
      $('qYear').value = now.getFullYear() - 1911;
      $('qNum').value = String(Math.ceil((now.getMonth() + 1) / 3));
    }
  }
  function mode() { return document.querySelector('input[name=mode]:checked').value; }
  document.querySelectorAll('input[name=mode]').forEach(function (r) {
    r.addEventListener('change', function () {
      document.querySelectorAll('[data-mode]').forEach(function (d) { d.hidden = d.dataset.mode !== mode(); });
      updateRangeInfo();
    });
  });
  ['qYear', 'qNum', 'mFrom', 'mTo', 'dFrom', 'dTo'].forEach(function (id) { $(id).addEventListener('change', updateRangeInfo); $(id).addEventListener('input', updateRangeInfo); });
  ['optRain', 'optFill', 'optPmZero'].forEach(function (id) { $(id).addEventListener('change', saveSettings); });

  function currentRange() {
    var md = mode();
    if (md === 'quarter') {
      var y = Number($('qYear').value), q = Number($('qNum').value);
      if (!(y >= 1 && y < 300)) return { error: '請輸入民國年。' };
      var r = Core.quarterRange(y, q);
      r.label = y + 'Q' + q; r.title = '民國' + y + '年第' + q + '季'; return r;
    }
    if (md === 'months') {
      var a = $('mFrom').value, b = $('mTo').value;
      if (!a || !b) return { error: '尚未匯入資料。' };
      if (a > b) return { error: '起始月份晚於結束月份。' };
      var toM = b + '-' + (daysInMonth(b) < 10 ? '0' : '') + daysInMonth(b);
      return { from: a + '-01', to: toM, label: ymRoc(a) + '-' + ymRoc(b), title: rocMonth(a) + '～' + rocMonth(b) };
    }
    if (md === 'dates') {
      var f = $('dFrom').value, t = $('dTo').value;
      if (!f || !t) return { error: '請選擇起訖日期。' };
      if (f > t) return { error: '起始日期晚於結束日期。' };
      return { from: f, to: t, label: dRoc(f) + '-' + dRoc(t), title: Core.toRoc(f) + '～' + Core.toRoc(t) };
    }
    var ms = allMonths();
    if (!ms.length) return { error: '尚未匯入資料。' };
    var last = ms[ms.length - 1];
    return { from: ms[0] + '-01', to: last + '-' + daysInMonth(last), label: '全部累積', title: rocMonth(ms[0]) + '～' + rocMonth(last) + '（全部累積）' };
  }
  function ymRoc(ym) { return (Number(ym.slice(0, 4)) - 1911) + ym.slice(5, 7); }
  function dRoc(d) { return (Number(d.slice(0, 4)) - 1911) + d.slice(5, 7) + d.slice(8, 10); }

  function updateRangeInfo() {
    var r = currentRange(), el = $('rangeInfo');
    $('reportMsg').innerHTML = '';
    if (r.error) { el.textContent = r.error; setDl(false); return; }
    var have = {};
    allMonths().forEach(function (m) { have[m] = true; });
    var need = M.monthsInRange(r);
    var missing = need.filter(function (m) { return !have[m]; });
    var html = '期間：<b>' + esc(r.title) + '</b>（' + Core.toRoc(r.from) + '～' + Core.toRoc(r.to) + '）';
    var pend = M.reviewItems(state.chunks, review()).items.filter(function (it) {
      var d = it.ts.slice(0, 10); return it.status !== 'confirmed' && d >= r.from && d <= r.to;
    }).length;
    if (pend) html += '<div class="msg err">這個期間還有 <b>' + pend + '</b> 個備註時段尚未確認，報表會先採用月報原始數值。請到「② 備註時段確認」確認。</div>';
    if (missing.length === need.length) { html += '<div class="msg err">這個期間沒有任何已匯入的資料。</div>'; setDl(false); }
    else {
      if (missing.length) html += '<div class="msg warn">以下月份尚未匯入：' + missing.map(rocMonth).join('、') + '。報表會缺這些月份。</div>';
      setDl(true);
    }
    el.innerHTML = html;
  }
  function setDl(on) { $('dlAir').disabled = !on; $('dlNoise').disabled = !on; }

  function stamp() {
    var d = new Date(), p = Core.pad;
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function makeReport(kind) {
    var r = currentRange();
    if (r.error) return;
    var btn = kind === 'air' ? $('dlAir') : $('dlNoise');
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = '產生中…';
    paint().then(function () {
      var sensors = M.applyExclusions(M.sensorsFromChunks(state.chunks, state.sensors, r), review());
      var rep = Core.buildReports(sensors, r, {
        fillMissingDays: $('optFill').checked,
        importedMonths: allMonths(),
        zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : []
      });
      var rows = kind === 'air' ? rep.air : rep.noise;
      if (!rows.length) throw new Error(kind === 'air' ? '這個期間沒有空品資料。' : '這個期間沒有噪音資料。');
      var wb = kind === 'air' ? X.buildAirWorkbook(ExcelJS, rows, { includeRain: $('optRain').checked }) : X.buildNoiseWorkbook(ExcelJS, rows);
      return wb.xlsx.writeBuffer().then(function (buf) {
        var name = (kind === 'air' ? '空氣品質日均報表_' : '噪音Leq日晚夜報表_') + r.label + '_' + stamp() + '.xlsx';
        download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
        var sensorsN = {};
        rows.forEach(function (x) { sensorsN[x.id] = true; });
        var noData = rows.filter(function (x) { return x.note.indexOf('當日無資料') === 0; }).length;
        $('reportMsg').innerHTML = '<div class="msg ok">已下載「' + esc(name) + '」：' + Object.keys(sensorsN).length + ' 台感測器、' + rows.length + ' 列' +
          (noData ? '（其中 ' + noData + ' 列當日無資料）' : '') + '。</div>';
      });
    }).catch(function (e) {
      $('reportMsg').innerHTML = '<div class="msg err">' + esc(e.message || e) + '</div>';
    }).then(function () { btn.textContent = old; btn.disabled = false; });
  }
  $('dlAir').addEventListener('click', function () { makeReport('air'); });
  $('dlNoise').addEventListener('click', function () { makeReport('noise'); });

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function applySettings() {
    var s = state.meta.settings || {};
    if (typeof s.rain === 'boolean') $('optRain').checked = s.rain;
    if (typeof s.fill === 'boolean') $('optFill').checked = s.fill;
    if (typeof s.pmZero === 'boolean') $('optPmZero').checked = s.pmZero;
  }
  function saveSettings() {
    if (state.loadError) return;
    var v = { rain: $('optRain').checked, fill: $('optFill').checked, pmZero: $('optPmZero').checked };
    state.meta.settings = v;
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).catch(function () {});
  }

  // ---------------- ④ 名稱 ----------------
  function renderNames() {
    var ids = {};
    state.sensors.forEach(function (s) { ids[s.id] = s; });
    state.chunks.forEach(function (c) { if (!ids[c.id]) ids[c.id] = { id: c.id, label: '', name: c.id }; });
    var list = Object.keys(ids).sort();
    if (!list.length) { $('names').innerHTML = '<p class="hint">尚未匯入任何資料。</p>'; return; }
    $('names').innerHTML = '<table><tr><th>感測器編號</th><th class="l">月報表頭文字</th><th class="l">報表使用的名稱</th></tr>' +
      list.map(function (id) {
        var s = ids[id];
        return '<tr><td>' + esc(id) + '</td><td class="l">' + esc(s.label) + '</td><td class="l"><input type="text" class="namein" data-id="' + esc(id) + '" value="' + esc(s.name) + '"></td></tr>';
      }).join('') + '</table>';
  }
  $('saveNames').addEventListener('click', function () {
    if (state.loadError) return;
    var byId = {};
    state.sensors.forEach(function (s) { byId[s.id] = s; });
    var ops = [], empty = [];
    document.querySelectorAll('.namein').forEach(function (inp) {
      var id = inp.dataset.id, name = inp.value.trim();
      if (!name) { empty.push(id); return; }
      var s = byId[id] || { id: id, label: '' };
      ops.push({ store: 'sensors', type: 'put', value: { id: id, label: s.label, name: name } });
    });
    if (empty.length) { $('namesMsg').innerHTML = '<span class="msg err">名稱不可空白：' + esc(empty.join('、')) + '</span>'; return; }
    Store.writeBatch(ops).then(function () { $('namesMsg').innerHTML = '<span class="msg ok">已儲存 ' + ops.length + ' 個名稱。</span>'; return reload(); })
      .catch(function (e) { $('namesMsg').innerHTML = '<span class="msg err">儲存失敗：' + esc(e.message || e) + '</span>'; });
  });
  $('nameFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    f.arrayBuffer().then(function (buf) {
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(buf).then(function () {
        var found = {};
        X.workbookToSheets(wb).forEach(function (sh) {
          for (var r = 0; r < Math.min(10, sh.rows.length); r++) {
            var row = sh.rows[r].map(function (x) { return x === null ? '' : String(x).trim(); });
            var ci = row.indexOf('感測器編號'), ni = row.indexOf('感測器名稱');
            if (ci < 0 || ni < 0) continue;
            for (var k = r + 1; k < sh.rows.length; k++) {
              var id = sh.rows[k][ci], nm = sh.rows[k][ni];
              if (id !== null && id !== undefined && nm) found[String(id).trim()] = String(nm).trim();
            }
            break;
          }
        });
        var n = 0;
        document.querySelectorAll('.namein').forEach(function (inp) { if (found[inp.dataset.id]) { inp.value = found[inp.dataset.id]; n++; } });
        var total = Object.keys(found).length;
        $('namesMsg').innerHTML = total ? '<span class="msg info">從舊報表找到 ' + total + ' 個名稱，已填入 ' + n + ' 個。確認後請按「儲存名稱」。</span>'
          : '<span class="msg err">這份檔案裡找不到「感測器編號」「感測器名稱」兩欄。</span>';
      });
    }).catch(function (err) { $('namesMsg').innerHTML = '<span class="msg err">無法讀取：' + esc(err.message || err) + '</span>'; });
  });

  // ---------------- ② 備註時段確認 ----------------
  var LABEL = { TMP: 'TMP', HUM: 'HUM', PM10: 'PM10', PM25: 'PM2.5', TVOC: 'TVOC', WD: 'WD 風向', WS: 'WS 風速', RA: '雨量', LEQ: 'Leq' };
  var draft = {}; // key → exclude 陣列（畫面上尚未確認的勾選）
  function review() { return state.meta.review || {}; }
  function reviewHint() {
    var n = M.reviewItems(state.chunks, review()).items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    return n ? '<br><b>有 ' + n + ' 個備註時段需要確認</b>，請到「② 備註時段確認」。' : '';
  }
  function refreshReviewBadge() {
    var n = M.reviewItems(state.chunks, review()).items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    $('reviewBadge').hidden = !n; $('reviewBadge').textContent = n;
  }
  function fillReviewFilters() {
    var ri = M.reviewItems(state.chunks, review()).items;
    var ids = {}, ms = {};
    ri.forEach(function (it) { ids[it.id] = true; ms[it.ts.slice(0, 7)] = true; });
    var keepS = $('rvSensor').value, keepM = $('rvMonth').value;
    $('rvSensor').innerHTML = '<option value="">全部</option>' + Object.keys(ids).sort().map(function (id) { return '<option value="' + esc(id) + '">' + esc(id + ' ' + sensorName(id)) + '</option>'; }).join('');
    $('rvMonth').innerHTML = '<option value="">全部</option>' + Object.keys(ms).sort().map(function (m) { return '<option value="' + m + '">' + rocMonth(m) + '</option>'; }).join('');
    if (ids[keepS]) $('rvSensor').value = keepS;
    if (ms[keepM]) $('rvMonth').value = keepM;
  }
  ['rvStatus', 'rvSensor', 'rvMonth'].forEach(function (id) { $(id).addEventListener('change', function () { $('reviewResult').innerHTML = ''; renderReview(); }); });

  var shown = [];
  function renderReview() {
    var all = M.reviewItems(state.chunks, review());
    var todo = all.items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    $('reviewSummary').innerHTML = '<div class="msg ' + (todo ? 'err' : 'ok') + '">待確認 <b>' + todo + '</b> 筆（紅框）、已確認 ' + (all.items.length - todo) + ' 筆。' +
      '另有 ' + all.autoInvalid + ' 個備註時段的數值本來就全部是異常值（負值或空白），已自動不列入計算，不需確認。</div>';
    var st = $('rvStatus').value, fs = $('rvSensor').value, fm = $('rvMonth').value;
    shown = all.items.filter(function (it) {
      if (st === 'todo' && it.status === 'confirmed') return false;
      if (st === 'confirmed' && it.status !== 'confirmed') return false;
      if (fs && it.id !== fs) return false;
      if (fm && it.ts.slice(0, 7) !== fm) return false;
      return true;
    });
    var LIMIT = 300;
    var list = shown.slice(0, LIMIT);
    shown = list;
    if (!list.length) {
      $('reviewTable').innerHTML = '<p class="hint">' + (st === 'todo' ? '沒有待確認的時段。' : '沒有符合條件的時段。') + '</p>';
      $('reviewActions').hidden = true; return;
    }
    var cols = M.REVIEW_FIELDS.filter(function (f) { return list.some(function (it) { return it.fields.indexOf(f) >= 0; }); });
    var h = '<table class="rv"><tr><th>狀態</th><th>感測器</th><th>時間</th><th class="l">月報備註</th>' + cols.map(function (f) { return '<th>' + LABEL[f] + '</th>'; }).join('') + '<th>整列</th></tr>';
    list.forEach(function (it, i) {
      var ex = draft[it.key] || it.exclude;
      var cls = it.status === 'confirmed' ? '' : it.status === 'changed' ? 'changed' : 'pending';
      var stTxt = it.status === 'confirmed' ? '<span class="st-c">已確認</span>' : it.status === 'changed' ? '<span class="st-p">月報已更新<br>請重新確認</span>' : '<span class="st-p">待確認</span>';
      h += '<tr class="' + cls + '" data-i="' + i + '"><td>' + stTxt + '</td><td>' + esc(it.id) + '<br><span class="hint">' + esc(sensorName(it.id)) + '</span></td><td>' + esc(Core.toRoc(it.ts.slice(0, 10)) + ' ' + it.ts.slice(11)) + '</td><td class="note">' + esc(it.note) + '</td>';
      cols.forEach(function (f) {
        if (it.fields.indexOf(f) < 0) { h += '<td></td>'; return; }
        var v = it.v[f];
        if (v === null || v === undefined) { h += '<td class="val"><span class="hint">異常值<br>（已不計）</span></td>'; return; }
        if (v === 0 && (f === 'PM10' || f === 'PM25') && $('optPmZero').checked) { h += '<td class="val"><span class="v">0</span><span class="hint">PM 為 0<br>已不計</span></td>'; return; }
        var x = ex.indexOf(f) >= 0;
        h += '<td class="val' + (x ? ' x' : '') + '"><span class="v">' + esc(v) + '</span><label><input type="checkbox" data-f="' + f + '"' + (x ? ' checked' : '') + '> 不採用</label></td>';
      });
      h += '<td><button data-all="1">全部不採用</button><br><button data-all="0">全部採用</button></td></tr>';
    });
    h += '</table>';
    if (shown.length >= LIMIT) h += '<p class="hint">一次最多顯示 ' + LIMIT + ' 筆，請用上方的感測器或月份篩選。</p>';
    $('reviewTable').innerHTML = h;
    $('reviewActions').hidden = false;
    $('rvCount').textContent = '會把目前畫面上的 ' + list.length + ' 筆，依勾選結果存成「已確認」。';
  }
  $('reviewTable').addEventListener('change', function (e) {
    var cb = e.target; if (!cb.dataset || !cb.dataset.f) return;
    var tr = cb.closest('tr'), it = shown[Number(tr.dataset.i)];
    var ex = (draft[it.key] || it.exclude).slice();
    var i = ex.indexOf(cb.dataset.f);
    if (cb.checked && i < 0) ex.push(cb.dataset.f); if (!cb.checked && i >= 0) ex.splice(i, 1);
    draft[it.key] = ex;
    cb.closest('td').classList.toggle('x', cb.checked);
  });
  $('reviewTable').addEventListener('click', function (e) {
    var b = e.target; if (!b.dataset || b.dataset.all === undefined) return;
    var tr = b.closest('tr'), it = shown[Number(tr.dataset.i)];
    draft[it.key] = b.dataset.all === '1' ? it.validFields.slice() : [];
    tr.querySelectorAll('input[data-f]').forEach(function (cb) { cb.checked = b.dataset.all === '1'; cb.closest('td').classList.toggle('x', cb.checked); });
  });
  $('rvConfirm').addEventListener('click', function () {
    if (state.loadError || !shown.length) return;
    var before = review();
    var after = {};
    Object.keys(before).forEach(function (k) { after[k] = before[k]; });
    var at = new Date().toISOString();
    var rowByKey = {};
    state.chunks.forEach(function (c) { c.rows.forEach(function (r) { if (r.note) rowByKey[c.id + '|' + r.ts] = r; }); });
    var days = {};
    shown.forEach(function (it) {
      var ex = (draft[it.key] || it.exclude).filter(function (f) { return it.validFields.indexOf(f) >= 0; });
      after[it.key] = { sig: M.rowSig(rowByKey[it.key]), exclude: ex, at: at };
      days[it.id + '|' + it.ts.slice(0, 10)] = true;
    });
    var btn = $('rvConfirm'); btn.disabled = true;
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'review', value: after } }]).then(function () {
      var diff = recalcDiff(Object.keys(days), before, after);
      shown.forEach(function (it) { delete draft[it.key]; });
      return reload().then(function () { renderReview(); showRecalc(diff, Object.keys(days).length); });
    }).catch(function (e) {
      $('reviewResult').innerHTML = '<div class="msg err">儲存失敗，確認結果沒有寫入：' + esc(e.message || e) + '</div>';
    }).then(function () { btn.disabled = false; });
  });

  /** 比較確認前後，受影響的感測器日各項數值 */
  function recalcDiff(dayKeys, before, after) {
    var out = [];
    var opts = { fillMissingDays: false, zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : [] };
    var bySensor = {};
    dayKeys.forEach(function (k) { var p = k.split('|'); (bySensor[p[0]] = bySensor[p[0]] || []).push(p[1]); });
    Object.keys(bySensor).forEach(function (id) {
      var ds = bySensor[id].sort();
      var range = { from: ds[0], to: ds[ds.length - 1] };
      var base = M.sensorsFromChunks(state.chunks.filter(function (c) { return c.id === id; }), state.sensors, range);
      var A = Core.buildReports(M.applyExclusions(base, before), range, opts);
      var B = Core.buildReports(M.applyExclusions(base, after), range, opts);
      ['air', 'noise'].forEach(function (kind) {
        var bmap = {}; B[kind].forEach(function (r) { bmap[r.date] = r; });
        A[kind].forEach(function (ra) {
          if (ds.indexOf(ra.date) < 0) return;
          var rb = bmap[ra.date];
          var F = kind === 'air' ? [['TMP', 'TMP'], ['HUM', 'HUM'], ['PM10', 'PM10'], ['PM25', 'PM2.5'], ['TVOC', 'TVOC'], ['WS', 'WS'], ['WD', '最頻風向'], ['RA', '雨量']]
            : [['DAY', 'Leq日'], ['EVE', 'Leq晚'], ['NIGHT', 'Leq夜']];
          F.forEach(function (f) { if (ra[f[0]] !== rb[f[0]]) out.push([id, ra.date, f[1], ra[f[0]], rb[f[0]]]); });
        });
      });
    });
    return out;
  }
  function showRecalc(diff, nDays) {
    var fmt = function (v) { return v === null || v === undefined ? '（空白）' : esc(v); };
    var h = '<div class="msg ok">已確認並重新計算 ' + nDays + ' 個感測器日。' + (diff.length ? '以下 ' + diff.length + ' 個數值因此改變：' : '各項數值都沒有改變（全部採用原始數值）。') + '</div>';
    if (diff.length) {
      h += '<table><tr><th>感測器</th><th>日期</th><th>項目</th><th>確認前</th><th>確認後</th></tr>' + diff.map(function (d) {
        return '<tr><td>' + esc(d[0]) + ' ' + esc(sensorName(d[0])) + '</td><td>' + Core.toRoc(d[1]) + '</td><td>' + esc(d[2]) + '</td><td>' + fmt(d[3]) + '</td><td><b>' + fmt(d[4]) + '</b></td></tr>';
      }).join('') + '</table>';
    }
    $('reviewResult').innerHTML = h;
  }

  // ---------------- ⑥ 備份 ----------------
  $('backupBtn').addEventListener('click', function () {
    Store.loadAll().then(function (d) {
      var data = { app: 'env-quarterly-report', version: window.ENV_APP_VERSION, exportedAt: new Date().toISOString(), chunks: d.chunks, sensors: d.sensors, meta: d.meta };
      download(new Blob([JSON.stringify(data)], { type: 'application/json' }), '環境監測資料備份_' + stamp() + '.json');
    }).catch(function (e) { alertMsg('備份失敗：' + (e.message || e)); });
  });
  $('restoreFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f || state.loadError) return;
    f.text().then(function (t) {
      var d;
      try { d = JSON.parse(t); } catch (x) { throw new Error('不是有效的備份檔。'); }
      if (!d || d.app !== 'env-quarterly-report' || !Array.isArray(d.chunks) || !Array.isArray(d.sensors)) throw new Error('這不是本系統的備份檔。');
      d.chunks.forEach(function (c) {
        if (!c || typeof c.key !== 'string' || !Array.isArray(c.rows) || !Array.isArray(c.fields)) throw new Error('備份檔內容不完整。');
      });
      var months = {};
      d.chunks.forEach(function (c) { months[c.month] = true; });
      var rows = d.chunks.reduce(function (a, c) { return a + c.rows.length; }, 0);
      $('restoreMsg').innerHTML = '<span class="msg warn">備份檔含 ' + Object.keys(months).length + ' 個月、' + rows + ' 筆資料（' + esc(d.exportedAt || '') + '）。' +
        '還原會取代目前全部資料。 <button id="restoreYes" class="danger">確定還原</button> <button id="restoreNo">取消</button></span>';
      $('restoreNo').onclick = function () { $('restoreMsg').innerHTML = ''; };
      $('restoreYes').onclick = function () {
        var ops = [{ store: 'chunks', type: 'clear' }, { store: 'sensors', type: 'clear' }, { store: 'meta', type: 'clear' }];
        d.chunks.forEach(function (c) { ops.push({ store: 'chunks', type: 'put', value: c }); });
        d.sensors.forEach(function (s) { ops.push({ store: 'sensors', type: 'put', value: s }); });
        (d.meta || []).forEach(function (m) { ops.push({ store: 'meta', type: 'put', value: m }); });
        Store.writeBatch(ops).then(function () { $('restoreMsg').innerHTML = '<span class="msg ok">還原完成。</span>'; return reload(); })
          .catch(function (er) { $('restoreMsg').innerHTML = '<span class="msg err">還原失敗，原本的資料沒有變動：' + esc(er.message || er) + '</span>'; });
      };
    }).catch(function (er) { $('restoreMsg').innerHTML = '<span class="msg err">' + esc(er.message || er) + '</span>'; });
  });
})();
