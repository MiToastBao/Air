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
      if (b.dataset.tab === 'review') { renderReview(); fillManualForm(); }
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
    ['fileInput', 'delBtn', 'saveNames', 'restoreFile', 'mapFile', 'delYes', 'mnAdd', 'rvConfirm'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
  }

  function reload() {
    return Store.loadAll().then(function (d) {
      state.chunks = d.chunks; state.sensors = d.sensors;
      state.meta = {}; d.meta.forEach(function (m) { state.meta[m.key] = m.value; });
      applySettings();
      renderCoverage(); fillMonthSelects(); updateRangeInfo(); refreshReviewBadge(); fillReviewFilters(); fillManualForm();
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
      if (plan.newSensors.length) html += '<div class="msg info">新的感測器 ' + plan.newSensors.length + ' 台：' + esc(plan.newSensors.join('、')) + '。編號與名稱可在「⑤ 感測器編號與名稱」修改。</div>';
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
      return reload().then(function () { // 先重新載入，再算待確認筆數（否則會算到匯入前的舊資料）
        $('importPreview').innerHTML = '<div class="card"><div class="msg ok">匯入完成：新增 ' + plan.stats.added + ' 筆、覆蓋 ' + plan.stats.overwritten + ' 筆。可到「③ 已匯入資料」確認月份，或到「④ 產出報表」下載。' + reviewHint() + '</div></div>';
      });
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
  ['optRain', 'optFill', 'optPmZero', 'optPmRatio'].forEach(function (id) { $(id).addEventListener('change', saveSettings); });

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
      var sensors = applyAll(M.sensorsFromChunks(state.chunks, state.sensors, r), review(), manual());
      var rep = Core.buildReports(sensors, r, {
        fillMissingDays: $('optFill').checked,
        importedMonths: allMonths(),
        zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : [], pmRatioInvalid: $('optPmRatio').checked
      });
      var rows = (kind === 'air' ? rep.air : rep.noise).map(function (x) { x.id = reportId(x.id); return x; });
      rows.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
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
    if (typeof s.pmRatio === 'boolean') $('optPmRatio').checked = s.pmRatio;
  }
  function saveSettings() {
    if (state.loadError) return;
    var v = { rain: $('optRain').checked, fill: $('optFill').checked, pmZero: $('optPmZero').checked, pmRatio: $('optPmRatio').checked };
    state.meta.settings = v;
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).catch(function () {});
  }

  // ---------------- ④ 名稱 ----------------
  function allSensorMeta() {
    var ids = {};
    state.sensors.forEach(function (s) { ids[s.id] = s; });
    state.chunks.forEach(function (c) { if (!ids[c.id]) ids[c.id] = { id: c.id, label: '', name: c.id }; });
    return Object.keys(ids).sort().map(function (id) { return ids[id]; });
  }
  function reportId(id) {
    var s = state.sensors.find(function (x) { return x.id === id; });
    return s && s.reportId ? s.reportId : id;
  }
  function dataIds() { var o = {}; state.chunks.forEach(function (c) { o[c.id] = true; }); return Object.keys(o); }
  function renderNames() {
    var list = allSensorMeta();
    if (!list.length) { $('names').innerHTML = '<p class="hint">尚未匯入任何資料。</p>'; return; }
    $('names').innerHTML = '<table><tr><th>月報感測器編號</th><th class="l">月報表頭文字</th><th class="l">報表感測器編號</th><th class="l">報表感測器名稱</th></tr>' +
      list.map(function (s) {
        return '<tr><td>' + esc(s.id) + '</td><td class="l">' + esc(s.label) + '</td><td class="l"><input type="text" class="ridin" data-id="' + esc(s.id) + '" value="' + esc(s.reportId || s.id) + '" style="width:110px"></td>' +
          '<td class="l"><input type="text" class="namein" data-id="' + esc(s.id) + '" value="' + esc(s.name) + '"></td></tr>';
      }).join('') + '</table>';
  }
  $('saveNames').addEventListener('click', function () {
    if (state.loadError) return;
    var rows = [];
    var empty = [];
    document.querySelectorAll('.namein').forEach(function (inp) {
      var id = inp.dataset.id, name = inp.value.trim();
      var rid = document.querySelector('.ridin[data-id="' + id + '"]').value.trim() || id;
      if (!name) empty.push(id);
      rows.push({ src: id, rid: rid, name: name, line: 0 });
    });
    if (empty.length) { $('namesMsg').innerHTML = '<span class="msg err">名稱不可空白：' + esc(empty.join('、')) + '</span>'; return; }
    var plan = M.planMapping({ rows: rows, errors: [], warnings: [] }, state.sensors, dataIds());
    if (!plan.ok) { $('namesMsg').innerHTML = '<span class="msg err">' + plan.errors.map(esc).join('<br>') + '</span>'; return; }
    if (!plan.ops.length) { $('namesMsg').innerHTML = '<span class="msg info">沒有任何變更。</span>'; return; }
    Store.writeBatch(plan.ops).then(reload).then(function () { renderNames(); $('namesMsg').innerHTML = '<span class="msg ok">已儲存 ' + plan.ops.length + ' 台感測器的設定，之後下載的報表會使用新的編號與名稱。</span>'; })
      .catch(function (e) { $('namesMsg').innerHTML = '<span class="msg err">儲存失敗：' + esc(e.message || e) + '</span>'; });
  });
  $('mapTpl').addEventListener('click', function () {
    reload().then(buildTemplate).catch(function (e) { $('mapPreview').innerHTML = '<div class="msg err">範本產生失敗：' + esc(e.message || e) + '</div>'; });
  });
  function buildTemplate() {
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('感測器對照');
    ws.addRow(['月報感測器編號', '報表感測器編號', '感測器名稱', '月報表頭文字（參考，不會匯入）']);
    allSensorMeta().forEach(function (s) { ws.addRow([s.id, s.reportId || s.id, s.name, s.label || '']); });
    [16, 16, 28, 36].forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
    ws.getRow(1).font = { bold: true };
    ws.getColumn(1).numFmt = '@'; ws.getColumn(2).numFmt = '@';
    var note = wb.addWorksheet('說明');
    ['填寫說明',
     '1. 「月報感測器編號」：月報工作表上的編號，用來找到是哪一台，請不要改。',
     '2. 「報表感測器編號」：報表上要顯示的編號。和月報編號一樣就不用改；留空白也視為相同。',
     '3. 「感測器名稱」：報表上要顯示的名稱。留空白＝維持目前名稱。',
     '4. 可以新增還沒有資料的感測器（先記下，之後匯入月報時就會使用）。',
     '5. 同一個報表編號不可以對應到兩台感測器。',
     '6. 存檔後到「⑤ 感測器編號與名稱」按「匯入對照表」，確認內容後按「確認套用」。'].forEach(function (t) { note.addRow([t]); });
    note.getColumn(1).width = 90; note.getRow(1).font = { bold: true };
    wb.xlsx.writeBuffer().then(function (buf) {
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), '感測器編號對照範本_' + stamp() + '.xlsx');
    });
  }
  var mapPending = null;
  $('mapFile').addEventListener('change', function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    mapPending = null;
    $('mapPreview').innerHTML = '<div class="msg info">讀取中…</div>';
    f.arrayBuffer().then(function (buf) {
      var wb = new ExcelJS.Workbook();
      return wb.xlsx.load(buf).then(function () {
        var parsed = M.parseMapping(X.workbookToSheets(wb));
        var plan = M.planMapping(parsed, state.sensors, dataIds());
        var h = '<div class="card">';
        if (!plan.ok) {
          h += '<div class="msg err"><b>無法匯入：</b><br>' + plan.errors.map(esc).join('<br>') + '</div>';
        } else {
          h += '<div class="msg info">「' + esc(f.name) + '」共 ' + parsed.rows.length + ' 台：要修改 <b>' + plan.changes.length + '</b> 台、沒有變動 ' + plan.same + ' 台。</div>';
          if (plan.noData.length) h += '<div class="msg warn">以下編號目前還沒有匯入資料，會先記下：' + esc(plan.noData.join('、')) + '</div>';
          if (plan.warnings.length) h += '<div class="msg warn">' + plan.warnings.map(esc).join('<br>') + '</div>';
          if (plan.changes.length) {
            h += '<table><tr><th>月報編號</th><th>報表編號</th><th class="l">感測器名稱</th></tr>' + plan.changes.map(function (c) {
              var ridTxt = c.oldRid === c.rid ? esc(c.rid) : '<s>' + esc(c.oldRid) + '</s> → <b>' + esc(c.rid) + '</b>';
              var nmTxt = c.oldName === c.name ? esc(c.name) : '<s>' + esc(c.oldName) + '</s> → <b>' + esc(c.name) + '</b>';
              return '<tr><td>' + esc(c.src) + '</td><td>' + ridTxt + '</td><td class="l">' + nmTxt + '</td></tr>';
            }).join('') + '</table>';
            h += '<div class="row"><button id="mapYes" class="primary" type="button">確認套用</button><button id="mapNo" type="button">取消</button></div>';
            mapPending = plan;
          }
        }
        $('mapPreview').innerHTML = h + '</div>';
        if ($('mapYes')) {
          $('mapYes').onclick = function () {
            if (state.loadError || !mapPending) return;
            $('mapYes').disabled = true;
            var n = mapPending.ops.length;
            Store.writeBatch(mapPending.ops).then(function () {
              mapPending = null;
              return reload();
            }).then(function () {
              renderNames();
              $('mapPreview').innerHTML = '<div class="msg ok">已更新 ' + n + ' 台感測器的編號／名稱。之後下載的報表會自動使用新的設定。</div>';
            }).catch(function (er) { $('mapPreview').innerHTML = '<div class="msg err">套用失敗，沒有任何變更：' + esc(er.message || er) + '</div>'; });
          };
          $('mapNo').onclick = function () { mapPending = null; $('mapPreview').innerHTML = ''; };
        }
      });
    }).catch(function (err) { $('mapPreview').innerHTML = '<div class="msg err">無法讀取這份檔案：請確認是 .xlsx 且沒有密碼保護。</div>'; });
  });

  // ---------------- ② 備註時段確認 ----------------
  var LABEL = { TMP: 'TMP', HUM: 'HUM', PM10: 'PM10', PM25: 'PM2.5', TVOC: 'TVOC', WD: 'WD 風向', WS: 'WS 風速', RA: '雨量', LEQ: 'Leq' };
  var draft = {}; // key → exclude 陣列（畫面上尚未確認的勾選）
  function review() { return state.meta.review || {}; }
  function manual() { return state.meta.manual || []; }
  function applyAll(base, rev, man) { return M.applyManual(M.applyExclusions(base, rev), man); }
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
  ['rvStatus', 'rvSensor', 'rvMonth'].forEach(function (id) { $(id).addEventListener('change', function () { $('reviewResult').innerHTML = ''; $('rvBulkMsg').innerHTML = ''; renderReview(); }); });

  var shown = [];
  var selected = {};      // key → true：左邊「選取」勾起來的列
  var noteOff = {};       // 月報備註篩選：被取消勾選（不顯示）的備註文字
  var bulkFields = {};    // 批次區勾選的測項

  function baseFiltered(all) {
    var st = $('rvStatus').value, fs = $('rvSensor').value, fm = $('rvMonth').value;
    return all.items.filter(function (it) {
      if (st === 'todo' && it.status === 'confirmed') return false;
      if (st === 'confirmed' && it.status !== 'confirmed') return false;
      if (fs && it.id !== fs) return false;
      if (fm && it.ts.slice(0, 7) !== fm) return false;
      return true;
    });
  }
  function isPmZero(it, f) { return it.v[f] === 0 && (f === 'PM10' || f === 'PM25') && $('optPmZero').checked; }
  function isPmRatio(it, f) {
    if ((f !== 'PM10' && f !== 'PM25') || !$('optPmRatio').checked) return false;
    var a = it.v.PM10, b = it.v.PM25;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    if ($('optPmZero').checked && (a === 0 || b === 0)) return false;
    return b > a;
  }
  function editable(it, f) { return it.validFields.indexOf(f) >= 0 && !isPmZero(it, f) && !isPmRatio(it, f); }

  function renderNoteFilter(base) {
    var cnt = {}, order = [];
    base.forEach(function (it) { if (!(it.note in cnt)) { cnt[it.note] = 0; order.push(it.note); } cnt[it.note]++; });
    order.sort(function (a, b) { return cnt[b] - cnt[a] || (a < b ? -1 : 1); });
    var on = order.filter(function (n) { return !noteOff[n]; }).length;
    $('rvNoteSum').textContent = '月報備註篩選（' + (on === order.length ? '全部' : on + ' / ' + order.length + ' 項') + '）';
    $('rvNoteList').innerHTML = order.map(function (n) {
      return '<label class="nf"><input type="checkbox" data-note="' + esc(n) + '"' + (noteOff[n] ? '' : ' checked') + '> ' + esc(n) + ' <span class="hint">(' + cnt[n] + ')</span></label>';
    }).join('');
    $('rvNoteAll').checked = on === order.length;
    $('rvNoteAll').indeterminate = on > 0 && on < order.length;
  }

  function renderReview() {
    var all = M.reviewItems(state.chunks, review());
    var todo = all.items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    $('reviewSummary').innerHTML = '<div class="msg ' + (todo ? 'err' : 'ok') + '">待確認 <b>' + todo + '</b> 筆（紅框）、已確認 ' + (all.items.length - todo) + ' 筆。' +
      '另有 ' + all.autoInvalid + ' 個備註時段的數值本來就全部是異常值（負值或空白），已自動不列入計算，不需確認。</div>';
    var base = baseFiltered(all);
    renderNoteFilter(base);
    var st = $('rvStatus').value;
    var filtered = base.filter(function (it) { return !noteOff[it.note]; });
    var LIMIT = 1000;
    var list = filtered.slice(0, LIMIT);
    shown = list;
    var keys = {}; list.forEach(function (it) { keys[it.key] = true; });
    Object.keys(selected).forEach(function (k) { if (!keys[k]) delete selected[k]; }); // 篩選掉的列不再算選取
    if (!list.length) {
      $('reviewTable').innerHTML = base.length
        ? '<p class="msg warn">「月報備註篩選」把 ' + base.length + ' 筆都隱藏了。請打開上方的篩選，勾選「全選」即可顯示。</p>'
        : '<p class="hint">' + (st === 'todo' ? '沒有待確認的時段。' : '沒有符合條件的時段。') + '</p>';
      $('reviewActions').hidden = true; $('rvBulk').hidden = true; return;
    }
    var cols = M.REVIEW_FIELDS.filter(function (f) { return list.some(function (it) { return it.fields.indexOf(f) >= 0; }); });
    Object.keys(bulkFields).forEach(function (f) { if (cols.indexOf(f) < 0) delete bulkFields[f]; });
    $('rvBulkFields').innerHTML = cols.map(function (f) {
      return '<label class="bf"><input type="checkbox" data-bf="' + f + '"' + (bulkFields[f] ? ' checked' : '') + '> ' + LABEL[f] + '</label>';
    }).join('');
    var h = '<table class="rv"><tr><th><label title="全選／取消全選目前列出的列"><input type="checkbox" id="rvSelAll"> 選取</label></th><th>狀態</th><th>感測器</th><th>時間</th><th class="l">月報備註</th>' + cols.map(function (f) { return '<th>' + LABEL[f] + '</th>'; }).join('') + '<th>整列</th></tr>';
    list.forEach(function (it, i) {
      var ex = draft[it.key] || it.exclude;
      var cls = (it.status === 'confirmed' ? '' : it.status === 'changed' ? 'changed' : 'pending') + (selected[it.key] ? ' sel' : '');
      var stTxt = it.status === 'confirmed' ? '<span class="st-c">已確認</span>' : it.status === 'changed' ? '<span class="st-p">月報已更新<br>請重新確認</span>' : '<span class="st-p">待確認</span>';
      h += '<tr class="' + cls + '" data-i="' + i + '"><td><input type="checkbox" class="rowSel"' + (selected[it.key] ? ' checked' : '') + '></td><td>' + stTxt + '</td><td>' + esc(it.id) + '<br><span class="hint">' + esc(sensorName(it.id)) + '</span></td><td>' + esc(Core.toRoc(it.ts.slice(0, 10)) + ' ' + it.ts.slice(11)) + '</td><td class="note">' + esc(it.note) + '</td>';
      cols.forEach(function (f) {
        if (it.fields.indexOf(f) < 0) { h += '<td></td>'; return; }
        var v = it.v[f];
        if (v === null || v === undefined) { h += '<td class="val"><span class="hint">異常值<br>（已不計）</span></td>'; return; }
        if (isPmZero(it, f)) { h += '<td class="val"><span class="v">0</span><span class="hint">PM 為 0<br>已不計</span></td>'; return; }
        if (isPmRatio(it, f)) { h += '<td class="val"><span class="v">' + esc(v) + '</span><span class="hint">PM2.5&gt;PM10<br>已不計</span></td>'; return; }
        var x = ex.indexOf(f) >= 0;
        h += '<td class="val' + (x ? ' x' : '') + '"><span class="v">' + esc(v) + '</span><label><input type="checkbox" data-f="' + f + '"' + (x ? ' checked' : '') + '> 不採用</label></td>';
      });
      h += '<td><button data-all="1">全部不採用</button><br><button data-all="0">全部採用</button></td></tr>';
    });
    h += '</table>';
    if (filtered.length > LIMIT) h += '<p class="msg warn">符合條件的有 ' + filtered.length + ' 筆，一次最多列出 ' + LIMIT + ' 筆；請用感測器、月份或備註篩選縮小範圍。</p>';
    $('reviewTable').innerHTML = h;
    $('reviewActions').hidden = false; $('rvBulk').hidden = false;
    $('rvCount').textContent = '會把目前列出的 ' + list.length + ' 筆，依勾選結果存成「已確認」。';
    updateSelCount();
  }
  function updateSelCount() {
    var n = shown.filter(function (it) { return selected[it.key]; }).length;
    $('rvSelN').textContent = n;
    var all = $('rvSelAll');
    if (all) { all.checked = n > 0 && n === shown.length; all.indeterminate = n > 0 && n < shown.length; }
  }
  // 月報備註篩選（像 Excel 篩選器）
  $('rvNoteList').addEventListener('change', function (e) {
    var n = e.target.dataset.note; if (n === undefined) return;
    if (e.target.checked) delete noteOff[n]; else noteOff[n] = true;
    renderReview();
  });
  $('rvNoteAll').addEventListener('change', function (e) {
    var on = e.target.checked;
    $('rvNoteList').querySelectorAll('input[data-note]').forEach(function (cb) { if (on) delete noteOff[cb.dataset.note]; else noteOff[cb.dataset.note] = true; });
    renderReview();
  });
  $('rvNoteOnly').addEventListener('click', function () { // 只看「勾選列」的備註
    var keep = {};
    shown.forEach(function (it) { if (selected[it.key]) keep[it.note] = true; });
    if (!Object.keys(keep).length) { $('rvBulkMsg').innerHTML = '<span class="msg warn">請先在左邊勾選幾列。</span>'; return; }
    $('rvNoteList').querySelectorAll('input[data-note]').forEach(function (cb) { if (keep[cb.dataset.note]) delete noteOff[cb.dataset.note]; else noteOff[cb.dataset.note] = true; });
    renderReview();
  });
  function kwFilter() {
    var kw = $('rvKw').value.trim().toLowerCase();
    if (!kw) { $('rvBulkMsg').innerHTML = '<span class="msg warn">請輸入關鍵字，例如 PM。</span>'; return; }
    var boxes = Array.from($('rvNoteList').querySelectorAll('input[data-note]'));
    var hit = boxes.filter(function (cb) { return cb.dataset.note.toLowerCase().indexOf(kw) >= 0; });
    if (!hit.length) { $('rvBulkMsg').innerHTML = '<span class="msg warn">目前列出的備註沒有含「' + esc(kw) + '」的，篩選維持不變。</span>'; return; }
    boxes.forEach(function (cb) { if (hit.indexOf(cb) >= 0) delete noteOff[cb.dataset.note]; else noteOff[cb.dataset.note] = true; });
    renderReview();
    $('rvBulkMsg').innerHTML = '<span class="msg info">已篩選出備註含「' + esc(kw) + '」的 ' + hit.length + ' 種備註。</span>';
  }
  $('rvKwBtn').addEventListener('click', kwFilter);
  $('rvKw').addEventListener('keydown', function (e) { if (e.key === 'Enter') kwFilter(); });
  // 選取列
  $('reviewTable').addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'rvSelAll') {
      shown.forEach(function (it) { if (t.checked) selected[it.key] = true; else delete selected[it.key]; });
      $('reviewTable').querySelectorAll('tr[data-i]').forEach(function (tr) { tr.querySelector('.rowSel').checked = t.checked; tr.classList.toggle('sel', t.checked); });
      updateSelCount(); return;
    }
    if (t.classList.contains('rowSel')) {
      var tr0 = t.closest('tr'), it0 = shown[Number(tr0.dataset.i)];
      if (t.checked) selected[it0.key] = true; else delete selected[it0.key];
      tr0.classList.toggle('sel', t.checked);
      updateSelCount();
    }
  });
  $('rvBulkFields').addEventListener('change', function (e) {
    var f = e.target.dataset.bf; if (!f) return;
    if (e.target.checked) bulkFields[f] = true; else delete bulkFields[f];
  });
  function bulkApply(exclude) {
    var fs = Object.keys(bulkFields);
    var rows = shown.filter(function (it) { return selected[it.key]; });
    if (!rows.length) { $('rvBulkMsg').innerHTML = '<span class="msg warn">請先在左邊「選取」欄勾選要處理的列（表頭可全選）。</span>'; return; }
    if (!fs.length) { $('rvBulkMsg').innerHTML = '<span class="msg warn">請先勾選要處理的測項。</span>'; return; }
    var cells = 0;
    rows.forEach(function (it) {
      var ex = (draft[it.key] || it.exclude).slice();
      fs.forEach(function (f) {
        if (!editable(it, f)) return;
        var i = ex.indexOf(f);
        if (exclude && i < 0) { ex.push(f); cells++; }
        if (!exclude && i >= 0) { ex.splice(i, 1); cells++; }
      });
      draft[it.key] = ex;
    });
    renderReview();
    $('rvBulkMsg').innerHTML = '<span class="msg info">已把 ' + rows.length + ' 列的 ' + fs.map(function (f) { return LABEL[f]; }).join('、') + ' 設為「' + (exclude ? '不採用' : '採用') + '」（變動 ' + cells + ' 格）。確認無誤後請按下方「確認並重新計算」。</span>';
  }
  $('rvBulkX').addEventListener('click', function () { bulkApply(true); });
  $('rvBulkK').addEventListener('click', function () { bulkApply(false); });

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
      shown.forEach(function (it) { delete draft[it.key]; delete selected[it.key]; });
      $('rvBulkMsg').innerHTML = '';
      noteOff = {}; // 確認完一批後，備註篩選恢復全選，剩下的待確認時段才看得到
      return reload().then(function () { renderReview(); showRecalc(diff, Object.keys(days).length); });
    }).catch(function (e) {
      $('reviewResult').innerHTML = '<div class="msg err">儲存失敗，確認結果沒有寫入：' + esc(e.message || e) + '</div>';
    }).then(function () { btn.disabled = false; });
  });

  /** 比較確認前後，受影響的感測器日各項數值 */
  function recalcDiff(dayKeys, before, after, manBefore, manAfter) {
    if (manBefore === undefined) { manBefore = manual(); manAfter = manual(); }
    var out = [];
    var opts = { fillMissingDays: false, zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : [], pmRatioInvalid: $('optPmRatio').checked };
    var bySensor = {};
    dayKeys.forEach(function (k) { var p = k.split('|'); (bySensor[p[0]] = bySensor[p[0]] || []).push(p[1]); });
    Object.keys(bySensor).forEach(function (id) {
      var ds = bySensor[id].sort();
      var range = { from: ds[0], to: ds[ds.length - 1] };
      var base = M.sensorsFromChunks(state.chunks.filter(function (c) { return c.id === id; }), state.sensors, range);
      var A = Core.buildReports(applyAll(base, before, manBefore), range, opts);
      var B = Core.buildReports(applyAll(base, after, manAfter), range, opts);
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
  function showRecalc(diff, nDays, target, verb) {
    var fmt = function (v) { return v === null || v === undefined ? '（空白）' : esc(v); };
    var h = '<div class="msg ok">' + (verb || '已確認並重新計算') + ' ' + nDays + ' 個感測器日。' + (diff.length ? '以下 ' + diff.length + ' 個數值因此改變：' : '各項數值都沒有改變。') + '</div>';
    if (diff.length) {
      h += '<table><tr><th>感測器</th><th>日期</th><th>項目</th><th>確認前</th><th>確認後</th></tr>' + diff.map(function (d) {
        return '<tr><td>' + esc(d[0]) + ' ' + esc(sensorName(d[0])) + '</td><td>' + Core.toRoc(d[1]) + '</td><td>' + esc(d[2]) + '</td><td>' + fmt(d[3]) + '</td><td><b>' + fmt(d[4]) + '</b></td></tr>';
      }).join('') + '</table>';
    }
    $(target || 'reviewResult').innerHTML = h;
  }

  // ---------------- 手動新增不採用時段 ----------------
  function sensorFields(id) {
    var f = {};
    state.chunks.forEach(function (c) { if (c.id === id) c.fields.forEach(function (x) { f[x] = true; }); });
    return M.REVIEW_FIELDS.filter(function (x) { return f[x]; });
  }
  function fillManualForm() {
    var ids = {}; state.chunks.forEach(function (c) { ids[c.id] = true; });
    var keep = $('mnSensor').value;
    $('mnSensor').innerHTML = Object.keys(ids).sort().map(function (id) { return '<option value="' + esc(id) + '">' + esc(id + ' ' + sensorName(id)) + '</option>'; }).join('');
    if (ids[keep]) $('mnSensor').value = keep;
    renderManualFields(); renderManualList(); manualPreview();
  }
  function renderManualFields() {
    var keep = {}; $('mnFields').querySelectorAll('input:checked').forEach(function (cb) { keep[cb.dataset.mf] = true; });
    $('mnFields').innerHTML = sensorFields($('mnSensor').value).map(function (f) {
      return '<label class="bf"><input type="checkbox" data-mf="' + f + '"' + (keep[f] ? ' checked' : '') + '> ' + LABEL[f] + '</label>';
    }).join('') || '<span class="hint">（請先匯入資料）</span>';
  }
  function readManualForm() {
    var id = $('mnSensor').value, a = $('mnFrom').value, b = $('mnTo').value;
    var fields = Array.from($('mnFields').querySelectorAll('input:checked')).map(function (cb) { return cb.dataset.mf; });
    if (!id) return { error: '請選擇感測器。' };
    if (!a || !b) return { error: '請填入起訖時間。' };
    var from = a.replace('T', ' ').slice(0, 16), to = b.replace('T', ' ').slice(0, 16);
    if (from > to) return { error: '起始時間晚於結束時間。' };
    if (!fields.length) return { error: '請勾選至少一個測項。' };
    return { id: id, from: from, to: to, fields: fields, reason: $('mnReason').value.trim() };
  }
  function manualPreview() {
    var m = readManualForm(), el = $('mnPreview');
    if (m.error) { el.hidden = true; return; }
    var imp = M.manualImpact(state.chunks, m);
    el.hidden = false;
    el.innerHTML = imp.hours ? '這個範圍有 <b>' + imp.hours + '</b> 小時資料（' + imp.days.length + ' 天），會把 <b>' + imp.cells + '</b> 個有效數值設為不採用。'
      : '<span class="msg warn">這個範圍內沒有這台感測器的資料。</span>';
  }
  ['mnFrom', 'mnTo', 'mnReason'].forEach(function (id) { $(id).addEventListener('input', manualPreview); $(id).addEventListener('change', manualPreview); });
  $('mnSensor').addEventListener('change', function () { renderManualFields(); manualPreview(); });
  $('mnFields').addEventListener('change', manualPreview);
  function saveManual(after, dayKeys, msgVerb) {
    var before = manual();
    return Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'manual', value: after } }]).then(function () {
      var diff = recalcDiff(dayKeys, review(), review(), before, after);
      return reload().then(function () { renderManualList(); showRecalc(diff, dayKeys.length, 'mnResult', msgVerb); });
    });
  }
  $('mnAdd').addEventListener('click', function () {
    if (state.loadError) return;
    $('mnResult').innerHTML = '';
    var m = readManualForm();
    if (m.error) { $('mnResult').innerHTML = '<div class="msg err">' + esc(m.error) + '</div>'; return; }
    var imp = M.manualImpact(state.chunks, m);
    if (!imp.hours) { $('mnResult').innerHTML = '<div class="msg err">這個範圍內沒有這台感測器的資料，沒有新增。</div>'; return; }
    m.uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    m.at = new Date().toISOString();
    var after = manual().concat([m]);
    $('mnAdd').disabled = true;
    saveManual(after, imp.days.map(function (d) { return m.id + '|' + d; }), '已新增手動不採用時段並重新計算')
      .catch(function (e) { $('mnResult').innerHTML = '<div class="msg err">儲存失敗，沒有新增：' + esc(e.message || e) + '</div>'; })
      .then(function () { $('mnAdd').disabled = false; });
  });
  function fmtTs(t) { return Core.toRoc(t.slice(0, 10)) + ' ' + t.slice(11); }
  function renderManualList() {
    var list = manual();
    if (!list.length) { $('mnList').innerHTML = '<p class="hint">尚未設定。</p>'; return; }
    $('mnList').innerHTML = '<table><tr><th>感測器</th><th>從</th><th>到</th><th>測項</th><th class="l">原因</th><th>影響</th><th></th></tr>' + list.map(function (m) {
      var imp = M.manualImpact(state.chunks, m);
      return '<tr><td>' + esc(m.id) + '<br><span class="hint">' + esc(sensorName(m.id)) + '</span></td><td>' + fmtTs(m.from) + '</td><td>' + fmtTs(m.to) + '</td><td>' + m.fields.map(function (f) { return LABEL[f]; }).join('、') +
        '</td><td class="l">' + esc(m.reason || '') + '</td><td>' + imp.hours + ' 小時</td><td><button data-del="' + esc(m.uid) + '">刪除</button><span class="delc" data-for="' + esc(m.uid) + '" hidden> 確定刪除？<button class="danger" data-delyes="' + esc(m.uid) + '">確定</button><button data-delno="1">取消</button></span></td></tr>';
    }).join('') + '</table>';
  }
  $('mnList').addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset.del) { t.hidden = true; $('mnList').querySelector('.delc[data-for="' + t.dataset.del + '"]').hidden = false; return; }
    if (t.dataset.delno) { renderManualList(); return; }
    if (t.dataset.delyes) {
      if (state.loadError) return;
      $('mnResult').innerHTML = '';
      var m = manual().filter(function (x) { return x.uid === t.dataset.delyes; })[0];
      var after = manual().filter(function (x) { return x.uid !== t.dataset.delyes; });
      var imp = m ? M.manualImpact(state.chunks, m) : { days: [] };
      saveManual(after, imp.days.map(function (d) { return m.id + '|' + d; }), '已刪除手動不採用時段並重新計算')
        .catch(function (er) { $('mnResult').innerHTML = '<div class="msg err">刪除失敗：' + esc(er.message || er) + '</div>'; });
    }
  });

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
