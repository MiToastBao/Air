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
      if (b.dataset.tab === 'report') { updateRangeInfo(); renderNoiseNow(); }
      if (b.dataset.tab === 'noise') renderNoiseForm();
      if (b.dataset.tab === 'box') renderBoxForm();
      if (b.dataset.tab === 'trend') renderTrendForm();
      if (b.dataset.tab === 'names') { renderNames(); renderLife(); }
      if (b.dataset.tab === 'backup') refreshStorage();
      if (b.dataset.tab === 'review') { renderReview(); fillManualForm(); renderSuspects(); renderAutoForm(); renderGaps(); }
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
    ['fileInput', 'delBtn', 'saveNames', 'saveLife', 'restoreFile', 'mapFile', 'delYes', 'mnAdd', 'rvConfirm', 'clrProj', 'clrAll', 'projNew', 'projDel', 'autoSave'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
  }

  // ---------------- 展開／收合 ----------------
  var foldState = {};
  /** 長清單包成可展開收合的區塊；n 筆以內預設展開，超過預設收合；使用者按過就記住 */
  function fold(key, inner, n, unit, limit) {
    var open = key in foldState ? foldState[key] : n <= (limit || 12);
    return '<details class="fold" data-fold="' + key + '"' + (open ? ' open' : '') + '><summary><span class="fo">▾ 收合</span><span class="fc">▸ 展開</span>（共 ' + n + ' ' + unit + '）</summary>' + inner + '</details>';
  }
  document.addEventListener('toggle', function (e) { var d = e.target; if (d && d.dataset && d.dataset.fold) foldState[d.dataset.fold] = d.open; }, true);
  // ② 每個區塊的標題可點擊展開／收合
  document.querySelectorAll('#tab-review > .card').forEach(function (card) {
    var h2 = card.querySelector(':scope > h2'); if (!h2) return;
    var body = document.createElement('div'); body.className = 'cardbody';
    while (h2.nextSibling) body.appendChild(h2.nextSibling);
    card.appendChild(body);
    h2.classList.add('foldh'); h2.title = '點一下展開／收合';
    h2.insertAdjacentHTML('beforeend', '<span class="foldtip">（點標題可收合）</span>');
    h2.addEventListener('click', function (e) { if (e.target.closest('a,button,input,select,label')) return; setFold(card, !card.classList.contains('folded')); });
  });
  function setFold(card, folded) {
    card.classList.toggle('folded', folded);
    var t = card.querySelector('.foldtip'); if (t) t.textContent = folded ? '（已收合，點標題展開）' : '（點標題可收合）';
  }
  document.querySelectorAll('#jumpBar [data-jump]').forEach(function (b) {
    b.addEventListener('click', function () {
      var card = $(b.dataset.jump); setFold(card, false);
      if (b.dataset.jump === 'gapCard') $('gpBox').open = true;
      jumpTo(card);
    });
  });
  // 上方的卡片可能還在補內容（高度會變），跳完再對準一次
  function jumpTo(card) {
    card.scrollIntoView({ block: 'start' });
    [250, 700, 1400].forEach(function (t) { setTimeout(function () { var y = card.getBoundingClientRect().top; if (Math.abs(y - 56) > 30) card.scrollIntoView({ block: 'start' }); }, t); });
  }
  $('jumpTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('foldAll').addEventListener('click', function () { document.querySelectorAll('#tab-review > .card').forEach(function (c) { setFold(c, true); }); $('ovCard').scrollIntoView({ block: 'start' }); });
  $('openAll').addEventListener('click', function () { document.querySelectorAll('#tab-review > .card').forEach(function (c) { setFold(c, false); }); });

  function reload() {
    return Store.loadAll().then(function (d) {
      procCache = null; gapCache = null;
      state.chunks = d.chunks; state.sensors = d.sensors;
      state.meta = {}; d.meta.forEach(function (m) { state.meta[m.key] = m.value; });
      applySettings();
      renderCoverage(); fillMonthSelects(); updateRangeInfo(); refreshReviewBadge(); fillReviewFilters(); fillManualForm(); refreshSuspectBadge(); refreshGapBadge();
      if (!$('tab-backup').hidden) refreshStorage();
    });
  }

  Store.open().then(function () { return renderProjects(); }).then(reload).then(function () { refreshStorage(); autoPersist(); })
    .catch(function (e) { fatal(e && e.message ? e.message : String(e)); });

  // ---------------- 計畫 ----------------
  var projList = [];
  function projLabel(p) { return (p.code ? p.code + '　' : '') + (p.name || '（未命名）'); }
  function renderProjects() {
    return Store.listProjects().then(function (list) {
      projList = list;
      var cur = Store.current();
      $('projSel').innerHTML = list.map(function (p) { return '<option value="' + esc(p.uid) + '">' + esc(projLabel(p)) + '</option>'; }).join('');
      if (cur) $('projSel').value = cur.uid;
      $('projCur').innerHTML = cur ? '目前計畫：<b>' + esc(cur.code || '（未設編號）') + '</b>　' + esc(cur.name || '（未命名）') + '　<span class="hint">各計畫的資料、確認結果與設定彼此獨立</span>' : '';
      document.title = (cur && cur.code ? cur.code + ' ' : '') + '微型感測器數據系統';
    });
  }
  function resetViews() {
    state.pending = null; $('importPreview').innerHTML = ''; $('reviewResult').innerHTML = ''; $('mnResult').innerHTML = ''; $('sgMsg').innerHTML = '';
    $('reportMsg').innerHTML = ''; $('mapPreview').innerHTML = ''; $('namesMsg').innerHTML = ''; $('restoreMsg').innerHTML = ''; $('clrMsg').innerHTML = ''; $('lifeMsg').innerHTML = '';
    draft = {}; selected = {}; noteOff = {};
    ['rvSensor', 'rvMonth', 'sgSensor', 'sgRule', 'delYear', 'delMonth'].forEach(function (id) { $(id).value = ''; });
    $('qYear').value = ''; $('dFrom').value = ''; $('dTo').value = '';
  }
  function switchTo(p) {
    return Store.openProject(p).then(function () { resetViews(); return renderProjects(); }).then(reload).then(function () {
      var tab = document.querySelector('.tabs button.on'); if (tab) tab.click();
    });
  }
  $('projSel').addEventListener('change', function () {
    var p = projList.filter(function (x) { return x.uid === $('projSel').value; })[0];
    if (p) switchTo(p).catch(function (e) { fatal(e.message || e); });
  });
  var projMode = null;
  function openProjForm(mode) {
    projMode = mode; var cur = Store.current();
    $('projFormTitle').textContent = mode === 'new' ? '新增計畫' : '修改計畫編號／名稱';
    $('projCode').value = mode === 'new' ? '' : (cur.code || ''); $('projName').value = mode === 'new' ? '' : (cur.name || '');
    $('projMsg').innerHTML = ''; $('projForm').hidden = false; $('projDelBox').hidden = true; $('projCode').focus();
  }
  ['projCode', 'projName'].forEach(function (id) {
    var inp = $(id);
    inp.addEventListener('focus', function () { if (inp.value) { inp.dataset.orig = inp.value; inp.value = ''; inp.placeholder = '原本：' + inp.dataset.orig + '（沒輸入就維持原本的）'; } });
    inp.addEventListener('blur', function () { if (!inp.value.trim() && inp.dataset.orig) inp.value = inp.dataset.orig; delete inp.dataset.orig; inp.placeholder = inp.dataset.ph || ''; });
    inp.dataset.ph = inp.placeholder;
  });
  $('projNew').addEventListener('click', function () { openProjForm('new'); });
  $('projEdit').addEventListener('click', function () { openProjForm('edit'); });
  $('projCancel').addEventListener('click', function () { $('projForm').hidden = true; });
  $('projSave').addEventListener('click', function () {
    var code = $('projCode').value.trim(), name = $('projName').value.trim();
    if (!code || !name) { $('projMsg').innerHTML = '<span class="msg err">計畫編號與名稱都要填。</span>'; return; }
    var dup = projList.filter(function (p) { return p.code === code && (projMode === 'new' || p.uid !== Store.current().uid); });
    if (dup.length) { $('projMsg').innerHTML = '<span class="msg err">已經有編號「' + esc(code) + '」的計畫了。</span>'; return; }
    var job = projMode === 'new'
      ? Store.createProject(code, name).then(function (p) { return switchTo(p); })
      : (function () { var p = Object.assign({}, Store.current(), { code: code, name: name }); return Store.updateProject(p).then(function () { return Store.openProject(p); }).then(renderProjects); })();
    job.then(function () { $('projForm').hidden = true; }).catch(function (e) { $('projMsg').innerHTML = '<span class="msg err">' + esc(e.message || e) + '</span>'; });
  });
  $('projDel').addEventListener('click', function () {
    $('projDelName').textContent = projLabel(Store.current()); $('projDelBox').hidden = false; $('projForm').hidden = true;
  });
  $('projDelNo').addEventListener('click', function () { $('projDelBox').hidden = true; });
  $('projDelYes').addEventListener('click', function () {
    var p = Store.current();
    Store.removeProject(p).then(function () { return Store.listProjects(); }).then(function (list) {
      $('projDelBox').hidden = true;
      if (list.length) return switchTo(list[0]);
      return Store.open().then(function () { resetViews(); return renderProjects(); }).then(reload);
    }).catch(function (e) { fatal(e.message || e); });
  });

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
    var nFiles = p.results.length, fileWarn = 0;
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
      if (!res.blocked && res.sensors.length) {
        var sg = M.detectSuspects(res.sensors.map(function (x) { return { id: x.id, name: x.id, fields: x.fields, rows: x.rows }; }), repOpts());
        if (sg.length) {
          var hrs = sg.reduce(function (a, g) { return a + g.hits; }, 0), byR = {};
          sg.forEach(function (g) { byR[g.label.split('，')[0].split('（')[0]] = (byR[g.label.split('，')[0].split('（')[0]] || 0) + 1; });
          html += '<div class="msg warn">發現 <b>' + sg.length + '</b> 段疑似異常（共 ' + hrs + ' 小時）：' + esc(Object.keys(byR).map(function (k) { return k + ' ' + byR[k] + ' 段'; }).join('、')) +
            '。匯入後預設不採用，請到「② 資料異常確認」的「疑似異常時段」逐段確認。</div>';
        }
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

    if (nFiles > 3) {
      p.results.forEach(function (r) { if (r.fatal || r.result.blocked || r.result.issues.some(function (x) { return x.level !== 'info'; })) fileWarn++; });
      foldState.files = fileWarn > 0 ? (foldState.files !== undefined ? foldState.files : true) : foldState.files;
      html = '<div class="card"><b>各檔案的檢查結果</b>' + (fileWarn ? '　<span class="tag warn">' + fileWarn + ' 份需要注意</span>' : '　<span class="tag ok">都沒有問題</span>') + fold('files', html, nFiles, '份檔案', 3) + '</div>';
    }
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
      var dupN = st.overwritten, dm = plan.dupMonths || {};
      html += '<h3>匯入前確認</h3><div class="msg info">這次選了 <b>' + importable + '</b> 份檔案：新資料 <b>' + st.added + '</b> 筆' + (dupN ? '、和已匯入的資料重複 <b>' + dupN + '</b> 筆' : '，沒有和已匯入的資料重複') + '。</div>';
      if (dupN) {
        html += '<div class="dupbox"><b>⚠ 已有 ' + dupN.toLocaleString() + ' 筆資料重複</b>（同一台感測器、同一個時間已經匯入過）：<ul>' + Object.keys(dm).sort().map(function (m) {
          return '<li>' + rocMonth(m) + '：' + dm[m].dup.toLocaleString() + ' 筆重複（' + Object.keys(dm[m].sensors).length + ' 台感測器）' +
            (dm[m].changed ? '，其中 <b>' + dm[m].changed.toLocaleString() + ' 筆數值或備註不同</b>' : '，內容與已匯入的完全相同') + '</li>';
        }).join('') + '</ul>' +
          (st.changed ? '覆蓋後，數值不同的那些小時會改用新檔案的數值；如果那些小時之前在「② 資料異常確認」確認過，會變成「月報已更新，請重新確認」。' : '內容完全相同，覆蓋或略過結果都一樣。') +
          '<br>請選擇：</div>';
        html += '<div class="row"><button id="confirmImport" class="danger">覆蓋重複的資料並匯入</button>' +
          (st.added ? '<button id="skipImport" class="primary">只匯入新資料（重複的保留原本）</button>' : '') +
          '<button id="cancelImport">取消匯入</button></div>';
      }
      if (plan.newInfo.length) html += '<div class="msg info"><b>新的感測器 ' + plan.newInfo.length + ' 台</b>，匯入時會自動新增（名稱取自月報表頭，可在「⑤ 感測器編號與名稱」修改）：' + fold('newsens', '<ul>' + plan.newInfo.map(function (x) {
        return '<li>' + esc(x.id) + '　' + esc(x.name) + (x.activeFrom ? '　<span class="hint">從 ' + esc(Core.toRoc(x.activeFrom)) + ' 起有資料，設為啟用日，之前的日子不算缺漏</span>' : '') + '</li>';
      }).join('') + '</ul>', plan.newInfo.length, '台', 8) + '</div>';
      if (plan.revived.length) html += '<div class="msg warn">以下感測器已設為停用，但這次的檔案有停用日之後的資料：' + esc(plan.revived.map(function (x) { return x.id + ' ' + x.name + '（停用日 ' + Core.toRoc(x.retiredFrom) + '）'; }).join('、')) + '。資料照樣匯入；如果感測器其實還在使用，請到「⑤ 感測器編號與名稱」清除停用日。</div>';
      if (plan.absent.length) {
        html += '<div class="dupbox" id="absentBox"><b>⚠ 這次匯入的月份缺少 ' + plan.absent.length + ' 台感測器的資料</b>（之前有匯入過這幾台）。請逐台選擇：<table style="margin-top:6px"><tr><th class="l">感測器</th><th>缺少的月份</th><th class="l">處理方式</th></tr>' + plan.absent.map(function (x) {
          var nm = 'ab_' + x.id;
          var rd = x.lastTs ? Core.addDays(x.lastTs.slice(0, 10), 1) : '', ad = x.nextTs ? x.nextTs.slice(0, 10) : '';
          var h = '<tr><td class="l">' + esc(x.id) + '<br><span class="hint">' + esc(x.name) + '</span></td><td>' + x.months.map(rocMonth).join('、') + '</td><td class="l" style="white-space:normal">' +
            '<label class="opt"><input type="radio" name="' + nm + '" value="later" checked> 資料少匯入，之後再補（「② 資料異常確認」會繼續列為缺漏）</label>';
          if (rd) h += '<label class="opt"><input type="radio" name="' + nm + '" value="retire"> 感測器已停用，停用日 <input type="date" data-abd="retire" data-id="' + esc(x.id) + '" value="' + rd + '"> <span class="hint">（最後一筆資料 ' + esc(fmtTs(x.lastTs)) + '）</span></label>';
          if (ad) h += '<label class="opt"><input type="radio" name="' + nm + '" value="notyet"> 那時還沒啟用，啟用日 <input type="date" data-abd="notyet" data-id="' + esc(x.id) + '" value="' + ad + '"> <span class="hint">（第一筆資料 ' + esc(fmtTs(x.nextTs)) + '）</span></label>';
          return h + '</td></tr>';
        }).join('') + '</table><span class="hint">停用日當天起、啟用日前一天以前，報表不列空白日、也不列為缺漏。之後可在「⑤ 感測器編號與名稱」修改。</span></div>';
      }
      if (!dupN) html += '<div class="row"><button id="confirmImport" class="primary">確認匯入</button><button id="cancelImport">取消</button></div>';
    }
    html += '</div>';
    $('importPreview').innerHTML = html;
    if ($('confirmImport')) $('confirmImport').addEventListener('click', function () { doImport(false); });
    if ($('skipImport')) $('skipImport').addEventListener('click', function () { doImport(true); });
    if ($('cancelImport')) $('cancelImport').addEventListener('click', function () { state.pending = null; $('importPreview').innerHTML = ''; });
  }

  function readAbsentChoices() {
    var out = {};
    if (!state.pending) return out;
    (state.pending.plan.absent || []).forEach(function (x) {
      var r = document.querySelector('input[name="ab_' + x.id + '"]:checked');
      if (!r || r.value === 'later') return;
      var inp = document.querySelector('input[data-abd="' + r.value + '"][data-id="' + x.id + '"]');
      if (inp && inp.value) out[x.id] = { kind: r.value, date: inp.value };
    });
    return out;
  }
  /** 把「已停用／尚未啟用」的選擇併進匯入的寫入動作 */
  function applyAbsentChoices(plan, sensors, choices) {
    var msgs = [];
    Object.keys(choices).forEach(function (id) {
      var op = plan.ops.find(function (o) { return o.store === 'sensors' && o.value.id === id; });
      var base = op ? op.value : (sensors.find(function (x) { return x.id === id; }) || { id: id, label: '', name: id });
      var v = {}; Object.keys(base).forEach(function (k) { v[k] = base[k]; });
      var c = choices[id];
      if (c.kind === 'retire') v.retiredFrom = c.date; else v.activeFrom = c.date;
      if (op) op.value = v; else plan.ops.push({ store: 'sensors', type: 'put', value: v });
      msgs.push(esc(id + ' ' + (v.name || id)) + (c.kind === 'retire' ? ' 設為停用（' + Core.toRoc(c.date) + ' 起）' : ' 設定啟用日 ' + Core.toRoc(c.date)));
    });
    return msgs.length ? '已設定：' + msgs.join('；') + '。' : '';
  }
  function doImport(skipExisting) {
    if (state.loadError || !state.pending || !state.pending.plan.ok) return;
    var btn = skipExisting ? $('skipImport') : $('confirmImport'), label = btn.textContent;
    ['confirmImport', 'skipImport', 'cancelImport'].forEach(function (id) { if ($(id)) $(id).disabled = true; });
    btn.textContent = '寫入中…';
    var choices = readAbsentChoices();
    // 寫入前以最新資料重新規劃，避免兩個分頁同時操作
    Store.loadAll().then(function (d) {
      var plan = M.planImport(state.pending.results.filter(function (r) { return r.result; }), d.chunks, d.sensors, { skipExisting: skipExisting });
      if (!plan.ok) throw new Error('資料有重複，請重新選擇檔案。');
      plan.lifeMsg = applyAbsentChoices(plan, d.sensors, choices);
      return Store.writeBatch(plan.ops).then(function () { return plan; });
    }).then(function (plan) {
      state.pending = null;
      return reload().then(function () { // 先重新載入，再算待確認筆數（否則會算到匯入前的舊資料）
        $('importPreview').innerHTML = '<div class="card"><div class="msg ok">匯入完成：新增 ' + plan.stats.added + ' 筆' + (skipExisting ? '、略過重複 ' + plan.stats.skipped + ' 筆（保留原本的資料）' : '、覆蓋 ' + plan.stats.overwritten + ' 筆') + '。可到「③ 已匯入資料」確認月份，或到「④ 產出報表」下載。' + reviewHint() + '</div>' + (plan.lifeMsg ? '<div class="msg info">' + plan.lifeMsg + '</div>' : '') + '</div>';
      });
    }).catch(function (e) {
      ['confirmImport', 'skipImport', 'cancelImport'].forEach(function (id) { if ($(id)) $(id).disabled = false; });
      btn.textContent = label;
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
    var RECENT = 6, old = cv.months.length - RECENT;
    cv.months.forEach(function (m, i) {
      var exp = daysInMonth(m) * 24;
      h += '<tr' + (i < old ? ' class="oldm"' : '') + '><td class="l">' + rocMonth(m) + '</td>' + cv.ids.map(function (id) {
        var n = cv.table[m][id];
        if (!n) return '<td class="bad">無</td>';
        return '<td class="' + (n < exp ? 'part' : '') + '">' + n + '</td>';
      }).join('') + '</tr>';
    });
    $('coverage').innerHTML = h + '</table>';
    var tbl = $('coverage').querySelector('table');
    if (old > 0) {
      if (covAll) tbl.classList.add('showall');
      var bad = cv.months.slice(0, old).filter(function (m) { return cv.ids.some(function (id) { return !cv.table[m][id] || cv.table[m][id] < daysInMonth(m) * 24; }); }).length;
      $('covTools').hidden = false;
      $('covAll').textContent = covAll ? '▾ 只顯示最近 ' + RECENT + ' 個月' : '▸ 顯示全部 ' + cv.months.length + ' 個月（另有較早的 ' + old + ' 個月）';
      $('covHint').textContent = !covAll && bad ? '較早的月份中有 ' + bad + ' 個月有缺資料或不完整（紅／黃格），展開可查看。' : '';
    } else $('covTools').hidden = true;
    fillDelSelects(cv.months);
  }
  // 刪除月份：年、月分開選，預設最新的月份
  function fillDelSelects(months) {
    var years = []; months.forEach(function (m) { var y = m.slice(0, 4); if (years.indexOf(y) < 0) years.push(y); });
    var ky = $('delYear').value;
    if (years.indexOf(ky) < 0) ky = years[years.length - 1] || '';
    $('delYear').innerHTML = years.map(function (y) { return '<option value="' + y + '">' + (Number(y) - 1911) + ' 年</option>'; }).join('');
    $('delYear').value = ky;
    fillDelMonth(months);
  }
  function fillDelMonth(months) {
    months = months || M.coverage(state.chunks).months;
    var y = $('delYear').value, km = $('delMonth').value;
    var ms = months.filter(function (m) { return m.slice(0, 4) === y; });
    if (ms.indexOf(km) < 0) km = ms[ms.length - 1] || '';
    $('delMonth').innerHTML = ms.map(function (m) { return '<option value="' + m + '">' + Number(m.slice(5, 7)) + ' 月</option>'; }).join('');
    $('delMonth').value = km;
    $('delConfirm').hidden = true;
  }
  $('delYear').addEventListener('change', function () { $('delMonth').value = ''; fillDelMonth(); });
  $('delMonth').addEventListener('change', function () { $('delConfirm').hidden = true; });
  var covAll = false;
  $('covAll').addEventListener('click', function () { covAll = !covAll; renderCoverage(); });
  $('delBtn').addEventListener('click', function () {
    if (!$('delMonth').value) return;
    var dm = $('delMonth').value, cs = state.chunks.filter(function (c) { return c.month === dm; });
    $('delMonthLabel').textContent = rocMonth(dm) + '（' + cs.length + ' 台感測器、' + cs.reduce(function (a, c) { return a + c.rows.length; }, 0).toLocaleString() + ' 筆）';
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
  ['optRain', 'optFill', 'optPmZero', 'optPmRatio', 'stdPM10', 'stdPM25', 'stdDAY', 'stdEVE', 'stdNIGHT'].forEach(function (id) { $(id).addEventListener('change', saveSettings); });

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
    if (pend) html += '<div class="msg err">這個期間還有 <b>' + pend + '</b> 個備註時段尚未確認，報表會先採用月報原始數值。請到「② 資料異常確認」確認。</div>';
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
      var sensors = proc().sensors;
      var rep = Core.buildReports(sensors, r, {
        fillMissingDays: $('optFill').checked,
        importedMonths: allMonths(),
        zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : [], pmRatioInvalid: $('optPmRatio').checked,
        noise: settings().noise
      });
      var rows = (kind === 'air' ? rep.air : rep.noise).map(function (x) { x.id = reportId(x.id); return x; });
      rows.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      if (!rows.length) throw new Error(kind === 'air' ? '這個期間沒有空品資料。' : '這個期間沒有噪音資料。');
      var std = stdValues(), nstd = noiseStdValues();
      var wb = kind === 'air' ? X.buildAirWorkbook(ExcelJS, rows, { includeRain: $('optRain').checked, std: std }) : X.buildNoiseWorkbook(ExcelJS, rows, { periods: Core.describeNoise(settings().noise), std: nstd });
      return wb.xlsx.writeBuffer().then(function (buf) {
        var pc = (Store.current() && Store.current().code) ? safeName(Store.current().code) + '_' : '';
        var name = pc + (kind === 'air' ? '空氣品質日均報表_' : '噪音Leq日晚夜報表_') + r.label + '_' + stamp() + '.xlsx';
        download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
        var sensorsN = {};
        rows.forEach(function (x) { sensorsN[x.id] = true; });
        var noData = rows.filter(function (x) { return x.note.indexOf('當日無資料') === 0; }).length;
        $('reportMsg').innerHTML = '<div class="msg ok">已下載「' + esc(name) + '」：' + Object.keys(sensorsN).length + ' 台感測器、' + rows.length + ' 列' +
          (noData ? '（其中 ' + noData + ' 列當日無資料）' : '') + '。' +
          (kind === 'air' ? '超過標準（PM10 &gt; ' + std.PM10 + '、PM2.5 &gt; ' + std.PM25 + '）的日平均共 ' + (wb.overCount || 0) + ' 格，已設為粗體＋底線。' : '超過標準（日間 &gt; ' + nstd.DAY + '、晚間 &gt; ' + nstd.EVE + '、夜間 &gt; ' + nstd.NIGHT + ' dB(A)）的 Leq 共 ' + (wb.overCount || 0) + ' 格，已設為粗體＋底線。') + '</div>';
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
    var sd = stdValues(); $('stdPM10').value = sd.PM10; $('stdPM25').value = sd.PM25;
    var nd = noiseStdValues(); $('stdDAY').value = nd.DAY; $('stdEVE').value = nd.EVE; $('stdNIGHT').value = nd.NIGHT;
  }
  function saveSettings() {
    if (state.loadError) return;
    var v = {}; Object.keys(settings()).forEach(function (k) { v[k] = settings()[k]; }); // 保留門檻、標準值等其他設定
    v.rain = $('optRain').checked; v.fill = $('optFill').checked; v.pmZero = $('optPmZero').checked; v.pmRatio = $('optPmRatio').checked;
    var a = Number($('stdPM10').value), b = Number($('stdPM25').value);
    v.std = { PM10: $('stdPM10').value !== '' && isFinite(a) ? a : 75, PM25: $('stdPM25').value !== '' && isFinite(b) ? b : 30 };
    v.nstd = {}; ['DAY', 'EVE', 'NIGHT'].forEach(function (k) { var x = Number($('std' + k).value); v.nstd[k] = $('std' + k).value !== '' && isFinite(x) ? x : NOISE_STD[k]; });
    state.meta.settings = v; procCache = null;
    refreshSuspectBadge();
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
    $('names').innerHTML = fold('names', '<table><tr><th>月報感測器編號</th><th class="l">月報表頭文字</th><th class="l">報表感測器編號</th><th class="l">報表感測器名稱</th></tr>' +
      list.map(function (s) {
        return '<tr><td>' + esc(s.id) + '</td><td class="l">' + esc(s.label) + '</td><td class="l"><input type="text" class="ridin" data-id="' + esc(s.id) + '" value="' + esc(s.reportId || s.id) + '" style="width:110px"></td>' +
          '<td class="l"><input type="text" class="namein" data-id="' + esc(s.id) + '" value="' + esc(s.name) + '"></td></tr>';
      }).join('') + '</table>', list.length, '台感測器', 25);
  }
  function renderLife() {
    var list = allSensorMeta();
    if (!list.length) { $('life').innerHTML = '<p class="hint">尚未匯入任何資料。</p>'; return; }
    var span = {};
    state.chunks.forEach(function (c) {
      if (!c.rows.length) return;
      var x = span[c.id] || (span[c.id] = { a: c.rows[0].ts, b: c.rows[c.rows.length - 1].ts });
      if (c.rows[0].ts < x.a) x.a = c.rows[0].ts; if (c.rows[c.rows.length - 1].ts > x.b) x.b = c.rows[c.rows.length - 1].ts;
    });
    $('life').innerHTML = fold('life', '<table><tr><th>月報感測器編號</th><th class="l">名稱</th><th>已匯入的資料</th><th>啟用日</th><th>停用日</th><th>狀態</th></tr>' + list.map(function (s) {
      var sp = span[s.id];
      var st = s.retiredFrom ? '<span class="tag warn">已停用</span>' : '<span class="tag ok">使用中</span>';
      return '<tr><td>' + esc(s.id) + '</td><td class="l">' + esc(s.name) + '</td><td>' + (sp ? esc(fmtTs(sp.a)) + '<br>～ ' + esc(fmtTs(sp.b)) : '（無）') + '</td>' +
        '<td><input type="date" class="lifeA" data-id="' + esc(s.id) + '" value="' + esc(s.activeFrom || '') + '"></td><td><input type="date" class="lifeR" data-id="' + esc(s.id) + '" value="' + esc(s.retiredFrom || '') + '"></td><td>' + st + '</td></tr>';
    }).join('') + '</table>', list.length, '台感測器', 25);
  }
  $('saveLife').addEventListener('click', function () {
    if (state.loadError) return;
    var ops = [], bad = [];
    allSensorMeta().forEach(function (s) {
      var a = document.querySelector('.lifeA[data-id="' + s.id + '"]').value || '', r = document.querySelector('.lifeR[data-id="' + s.id + '"]').value || '';
      if (a && r && r <= a) { bad.push(s.id); return; }
      if (a === (s.activeFrom || '') && r === (s.retiredFrom || '')) return;
      var v = {}; Object.keys(s).forEach(function (k) { v[k] = s[k]; });
      if (a) v.activeFrom = a; else delete v.activeFrom;
      if (r) v.retiredFrom = r; else delete v.retiredFrom;
      ops.push({ store: 'sensors', type: 'put', value: v });
    });
    if (bad.length) { $('lifeMsg').innerHTML = '<span class="msg err">停用日要晚於啟用日：' + esc(bad.join('、')) + '</span>'; return; }
    if (!ops.length) { $('lifeMsg').innerHTML = '<span class="msg info">沒有任何變更。</span>'; return; }
    Store.writeBatch(ops).then(reload).then(function () { renderLife(); $('lifeMsg').innerHTML = '<span class="msg ok">已儲存 ' + ops.length + ' 台。報表與「② 資料異常確認」已套用。</span>'; })
      .catch(function (e) { $('lifeMsg').innerHTML = '<span class="msg err">儲存失敗：' + esc(e.message || e) + '</span>'; });
  });
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
    note.getRow(1).font = { bold: true };
    Core.xlAutoFit(ws); Core.xlWrapCol(note, 1, 90); Core.xlFitHeights(note);
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
            h += fold('mapchg', '<table><tr><th>月報編號</th><th>報表編號</th><th class="l">感測器名稱</th></tr>' + plan.changes.map(function (c) {
              var ridTxt = c.oldRid === c.rid ? esc(c.rid) : '<s>' + esc(c.oldRid) + '</s> → <b>' + esc(c.rid) + '</b>';
              var nmTxt = c.oldName === c.name ? esc(c.name) : '<s>' + esc(c.oldName) + '</s> → <b>' + esc(c.name) + '</b>';
              return '<tr><td>' + esc(c.src) + '</td><td>' + ridTxt + '</td><td class="l">' + nmTxt + '</td></tr>';
            }).join('') + '</table>', plan.changes.length, '台要修改', 25);
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
  function settings() { return state.meta.settings || {}; }
  function suspectDec() {
    var d = state.meta.suspect || {};
    var ig = state.meta.suspectIgnore; // v1.3.0 的「這是真實數值」→ 採用
    if (ig) { d = Object.assign({}, d); Object.keys(ig).forEach(function (k) { if (!d[k]) d[k] = 'keep'; }); }
    return d;
  }
  function stdValues() {
    var sd = settings().std || {};
    return { PM10: typeof sd.PM10 === 'number' ? sd.PM10 : 75, PM25: typeof sd.PM25 === 'number' ? sd.PM25 : 30 };
  }
  var NOISE_STD = { DAY: 71, EVE: 69, NIGHT: 63 }; // 出廠預設（dB(A)）
  function noiseStdValues() {
    var sd = settings().nstd || {}, o = {};
    Object.keys(NOISE_STD).forEach(function (k) { o[k] = typeof sd[k] === 'number' ? sd[k] : NOISE_STD[k]; });
    return o;
  }
  function safeName(t) { return String(t).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40); }
  function repOpts() { return { zeroInvalid: $('optPmZero').checked ? Core.ZERO_INVALID : [], pmRatioInvalid: $('optPmRatio').checked, auto: settings().auto, noise: settings().noise }; }
  /** 全部資料跑完整流程（備註確認 → 手動 → 疑似異常自動判定）；結果快取到下一次重新載入 */
  var procCache = null;
  function proc() {
    if (!procCache) {
      procCache = M.processAll(M.sensorsFromChunks(state.chunks, state.sensors, null), review(), manual(), repOpts(), suspectDec());
      var am = {};
      procCache.sensors.forEach(function (x) { x.rows.forEach(function (r) { if (r.af) am[x.id + '|' + r.ts] = r.af; }); });
      procCache.autoMap = am;
    }
    return procCache;
  }
  /** 只改了疑似異常的確認結果時：不重新讀資料、不重新判定，只重新套用不採用（快） */
  function reapplyAuto() {
    if (!procCache) return;
    procCache.sensors = M.applyAuto(procCache.base, procCache.groups, suspectDec());
    var am = {};
    procCache.sensors.forEach(function (x) { x.rows.forEach(function (r) { if (r.af) am[x.id + '|' + r.ts] = r.af; }); });
    procCache.autoMap = am;
  }
  /** 單一感測器、指定的確認狀態下的完整流程（重新計算前後比較用） */
  function procOne(id, rev, man, dec) {
    return M.processAll(M.sensorsFromChunks(state.chunks.filter(function (c) { return c.id === id; }), state.sensors, null), rev, man, repOpts(), dec).sensors;
  }
  function reviewHint() {
    var n = M.reviewItems(state.chunks, review()).items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    return n ? '<br><b>有 ' + n + ' 個備註時段需要確認</b>，請到「② 資料異常確認」。' : '';
  }
  function refreshReviewBadge() {
    var n = M.reviewItems(state.chunks, review()).items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    $('reviewBadge').hidden = !n; $('reviewBadge').textContent = n;
  }
  // 感測器、月份下拉只列出「目前顯示狀態」下還有資料的選項，並附筆數；
  // 某台感測器全部確認完就從「待確認」的下拉消失，不會選了才發現早就處理過。
  function statusMatch(it) {
    var st = $('rvStatus').value;
    if (st === 'todo') return it.status !== 'confirmed';
    if (st === 'confirmed') return it.status === 'confirmed';
    return true;
  }
  function fillReviewFilters() {
    var ri = M.reviewItems(state.chunks, review()).items.filter(statusMatch);
    var keepS = $('rvSensor').value, keepM = $('rvMonth').value;
    var byS = {}, byM = {};
    ri.forEach(function (it) {
      var m = it.ts.slice(0, 7);
      if (!keepM || m === keepM) byS[it.id] = (byS[it.id] || 0) + 1;
      if (!keepS || it.id === keepS) byM[m] = (byM[m] || 0) + 1;
    });
    // 已選的感測器／月份在新狀態下沒有資料了 → 回到「全部」
    var resetS = keepS && !ri.some(function (it) { return it.id === keepS && (!keepM || it.ts.slice(0, 7) === keepM); });
    var resetM = keepM && !ri.some(function (it) { return it.ts.slice(0, 7) === keepM && (!keepS || resetS || it.id === keepS); });
    if (resetS || resetM) {
      if (resetS) keepS = '';
      if (resetM) keepM = '';
      byS = {}; byM = {};
      ri.forEach(function (it) {
        var m = it.ts.slice(0, 7);
        if (!keepM || m === keepM) byS[it.id] = (byS[it.id] || 0) + 1;
        if (!keepS || it.id === keepS) byM[m] = (byM[m] || 0) + 1;
      });
    }
    var totS = Object.keys(byS).reduce(function (a, k) { return a + byS[k]; }, 0);
    var totM = Object.keys(byM).reduce(function (a, k) { return a + byM[k]; }, 0);
    $('rvSensor').innerHTML = '<option value="">全部（' + totS + '）</option>' + Object.keys(byS).sort().map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(id + ' ' + sensorName(id)) + '（' + byS[id] + '）</option>';
    }).join('');
    $('rvMonth').innerHTML = '<option value="">全部（' + totM + '）</option>' + Object.keys(byM).sort().map(function (m) {
      return '<option value="' + m + '">' + rocMonth(m) + '（' + byM[m] + '）</option>';
    }).join('');
    $('rvSensor').value = byS[keepS] ? keepS : '';
    $('rvMonth').value = byM[keepM] ? keepM : '';
    return { resetS: resetS, resetM: resetM };
  }
  $('rvActiveOnly').addEventListener('change', function () { renderReview(); });
  ['rvStatus', 'rvSensor', 'rvMonth'].forEach(function (id) { $(id).addEventListener('change', function () { $('reviewResult').innerHTML = ''; $('rvBulkMsg').innerHTML = ''; fillReviewFilters(); renderReview(); }); });

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
  function autoOf(it, f) { var m = proc().autoMap; return !!(m[it.key] && m[it.key].indexOf(f) >= 0); }
  function editable(it, f) { return it.validFields.indexOf(f) >= 0 && !isPmZero(it, f) && !isPmRatio(it, f) && !autoOf(it, f); }
  /** 這一列還有沒有「採用中」的數值（可編輯、而且沒有勾不採用） */
  function hasActive(it, only) {
    var ex = draft[it.key] || it.exclude;
    return it.validFields.some(function (f) { return (!only || f === only) && editable(it, f) && ex.indexOf(f) < 0; });
  }

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
    setTimeout(renderOverview, 0);
    $('reviewSummary').innerHTML = '<div class="msg ' + (todo ? 'err' : 'ok') + '">待確認 <b>' + todo + '</b> 筆（紅框）、已確認 ' + (all.items.length - todo) + ' 筆。' +
      '另有 ' + all.autoInvalid + ' 個備註時段的數值本來就全部是異常值（負值或空白），已自動不列入計算，不需確認。</div>';
    var base = baseFiltered(all);
    renderNoteFilter(base);
    var st = $('rvStatus').value;
    var af = $('rvActiveOnly').value; // ''＝不篩選、'ANY'＝任一測項、其他＝指定測項
    var filtered = base.filter(function (it) { return !noteOff[it.note] && (!af || hasActive(it, af === 'ANY' ? null : af)); });
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
        if (autoOf(it, f)) { h += '<td class="val"><span class="v">' + esc(v) + '</span><span class="hint">自動判定異常<br>已不計</span></td>'; return; }
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
  function recalcDiff(dayKeys, before, after, manBefore, manAfter, decBefore, decAfter) {
    if (manBefore === undefined) { manBefore = manual(); manAfter = manual(); }
    if (decBefore === undefined) { decBefore = suspectDec(); decAfter = suspectDec(); }
    var out = [];
    var opts = repOpts(); opts.fillMissingDays = false;
    var bySensor = {};
    dayKeys.forEach(function (k) { var p = k.split('|'); (bySensor[p[0]] = bySensor[p[0]] || []).push(p[1]); });
    Object.keys(bySensor).forEach(function (id) {
      var ds = bySensor[id].sort();
      var range = { from: ds[0], to: ds[ds.length - 1] };
      var A = Core.buildReports(procOne(id, before, manBefore, decBefore), range, opts);
      var B = Core.buildReports(procOne(id, after, manAfter, decAfter), range, opts);
      ['air', 'noise'].forEach(function (kind) {
        var bmap = {}; B[kind].forEach(function (r) { bmap[r.date] = r; });
        A[kind].forEach(function (ra) {
          if (ds.indexOf(ra.date) < 0) return;
          var rb = bmap[ra.date];
          var F = kind === 'air' ? [['TMP', 'TMP'], ['HUM', 'HUM'], ['PM10', 'PM10'], ['PM25', 'PM2.5'], ['TVOC', 'TVOC'], ['WS', 'WS'], ['WD8', '最頻風向(8方位)'], ['RA', '雨量'], ['WD', '最頻風向(16方位)'], ['WD16S', '最頻風向16(風速大)'], ['WD16A', '最頻風向16(相鄰方位)'], ['WD8S', '最頻風向8(風速大)'], ['WD8A', '最頻風向8(相鄰方位)']]
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

  // ---------------- 疑似異常時段（自動判定，預設不採用） ----------------
  var RULE_ADV = {
    LEQ999: '999 通常是儀器的錯誤碼，不是真的量到 999 dB。',
    LEQHIGH: '這麼高的音量接近飛機起飛近距離，工地或道路旁也很少連續出現。',
    LEQLOW: '比深夜郊區還安靜，可能是儀器沒有正常收音。',
    PMCAP: '數值停在儀器上限附近，通常代表感測器飽和或故障，實際濃度無法得知。同一台的 PM10 與 PM2.5 通常一起受影響，所以兩個測項一起不採用。',
    HUM100: '相對濕度最大是 100%，些微超過可能是感測器誤差；若只超過一點點、時間很短，可以改回採用（視為接近飽和）。',
    TMPRANGE: '超出台灣一般環境的溫度範圍，可能是感測器故障。',
    WSHIGH: '這個風速已達強烈颱風等級，若當時沒有颱風，多半是感測器異常。',
    WDBAD: '風向角度只會在 0～360 度之間。',
    RAHIGH: '一小時雨量這麼大極少見，若當時沒有豪雨，多半是雨量計異常。',
    STUCK: '真實環境的數值每小時都會有些變化，同一個數字連續十幾個小時不變，常見原因是感測器卡住或通訊中斷後重複送出最後一筆。'
  };
  function sgStatus(g) { var d = suspectDec()[g.key]; return d === 'keep' ? 'keep' : d === 'exclude' ? 'exclude' : 'pending'; }
  function refreshSuspectBadge() {
    setTimeout(function () {
      var n = proc().groups.filter(function (g) { return sgStatus(g) === 'pending'; }).length;
      $('suspectBadge').hidden = !n; $('suspectBadge').textContent = '異常 ' + n;
      $('suspectBadge').title = n + ' 段疑似異常時段待確認（預設不採用）';
      if (!$('tab-review').hidden) renderSuspects();
    }, 30);
  }
  function fmtV(v) { return v === null || v === undefined ? '（空白）' : esc(v); }
  /** 這一段「不採用（目前預設）」與「採用」時，報表日平均的差別 */
  function suspectImpact(g) {
    var pc = proc(); pc.imp = pc.imp || {};
    if (pc.imp[g.key]) return pc.imp[g.key]; // 每段只算一次，資料或規則變動（重新載入）時才重算
    var range = { from: g.from.slice(0, 10), to: g.to.slice(0, 10) };
    var opts = repOpts(); opts.fillMissingDays = false;
    var ex = {}, keep = {};
    Object.keys(suspectDec()).forEach(function (k) { ex[k] = keep[k] = suspectDec()[k]; });
    ex[g.key] = 'exclude'; keep[g.key] = 'keep';
    var A = Core.buildReports(procOne(g.id, review(), manual(), keep), range, opts);
    var B = Core.buildReports(procOne(g.id, review(), manual(), ex), range, opts);
    var out = [];
    ['air', 'noise'].forEach(function (kind) {
      var bm = {}; B[kind].forEach(function (r) { bm[r.date] = r; });
      var F = kind === 'air' ? [['TMP', 'TMP'], ['HUM', 'HUM'], ['PM10', 'PM10'], ['PM25', 'PM2.5'], ['TVOC', 'TVOC'], ['WS', 'WS'], ['WD8', '最頻風向(8方位)'], ['RA', '雨量'], ['WD', '最頻風向(16方位)'], ['WD16S', '最頻風向16(風速大)'], ['WD16A', '最頻風向16(相鄰方位)'], ['WD8S', '最頻風向8(風速大)'], ['WD8A', '最頻風向8(相鄰方位)']] : [['DAY', 'Leq日'], ['EVE', 'Leq晚'], ['NIGHT', 'Leq夜']];
      A[kind].forEach(function (ra) { var rb = bm[ra.date]; F.forEach(function (f) { if (rb && ra[f[0]] !== rb[f[0]]) out.push([ra.date, f[1], ra[f[0]], rb[f[0]]]); }); });
    });
    pc.imp[g.key] = out;
    return out;
  }
  function fillSuspectFilters(list) {
    var ks = $('sgSensor').value, kr = $('sgRule').value, bs = {}, br = {}, lab = {};
    list.forEach(function (g) { bs[g.id] = (bs[g.id] || 0) + 1; br[g.rule] = (br[g.rule] || 0) + 1; lab[g.rule] = g.label; });
    $('sgSensor').innerHTML = '<option value="">全部（' + list.length + '）</option>' + Object.keys(bs).sort().map(function (id) { return '<option value="' + esc(id) + '">' + esc(id + ' ' + sensorName(id)) + '（' + bs[id] + '）</option>'; }).join('');
    $('sgRule').innerHTML = '<option value="">全部</option>' + Object.keys(br).map(function (r) { return '<option value="' + r + '">' + esc(lab[r].split('，')[0].split('（')[0]) + '（' + br[r] + '）</option>'; }).join('');
    $('sgSensor').value = bs[ks] ? ks : ''; $('sgRule').value = br[kr] ? kr : '';
  }
  var sgShown = [];
  function renderSuspects() {
    var groups = proc().groups, st = $('sgStatus').value;
    var list = groups.filter(function (g) { return st === 'all' || sgStatus(g) === st; });
    fillSuspectFilters(list);
    var fs = $('sgSensor').value, fr = $('sgRule').value;
    sgShown = list.filter(function (g) { return (!fs || g.id === fs) && (!fr || g.rule === fr); });
    var cnt = { pending: 0, exclude: 0, keep: 0 };
    groups.forEach(function (g) { cnt[sgStatus(g)]++; });
    setTimeout(renderOverview, 0);
    $('sgSummary').innerHTML = '<div class="msg ' + (cnt.pending ? 'warn' : 'ok') + '">待確認 <b>' + cnt.pending + '</b> 段（目前預設不採用）、已確認不採用 ' + cnt.exclude + ' 段、已改回採用 ' + cnt.keep + ' 段。</div>';
    $('sgBatch').hidden = !sgShown.length; $('sgSelBar').hidden = !sgShown.length;
    setTimeout(updateSgSel, 0);
    $('sgAllX').hidden = st === 'exclude'; $('sgAllK').hidden = st === 'keep'; $('sgAllR').hidden = st === 'pending';
    $('sgBatchN').textContent = sgShown.length;
    if (!sgShown.length) { $('sgList').innerHTML = '<p class="hint">' + (st === 'pending' ? '沒有待確認的疑似異常時段。' : '沒有符合條件的時段。') + '</p>'; return; }
    var LIMIT = 60;
    $('sgList').innerHTML = sgShown.slice(0, LIMIT).map(function (g) {
      var stt = sgStatus(g);
      var pcI = proc().imp || {}, imp = pcI[g.key];
      var fl = g.fields.map(function (f) { return LABEL[f]; }).join('、');
      var range = g.from === g.to ? fmtTs(g.from) : fmtTs(g.from) + ' ～ ' + fmtTs(g.to);
      var vr = g.min === g.max ? '數值 ' + g.min : '數值 ' + g.min + '～' + g.max;
      var tag = stt === 'pending' ? '<span class="tag err">待確認・目前不採用</span>' : stt === 'exclude' ? '<span class="tag warn">已確認不採用</span>' : '<span class="tag ok">已改回採用</span>';
      var h = '<div class="sg' + (stt === 'keep' ? ' ign' : '') + (sgSel[g.key] ? ' picked' : '') + '"><h4><label class="pick"><input type="checkbox" data-sgsel="' + esc(g.key) + '"' + (sgSel[g.key] ? ' checked' : '') + '> 勾選</label> ' + esc(g.id) + ' ' + esc(sensorName(g.id)) + '｜' + range + '（' + g.hours + ' 小時）' + tag + '</h4>';
      h += '<div class="what"><b>狀況：</b>' + esc(g.label) + '。' + (g.hits === g.hours ? '這段 ' + g.hours + ' 小時全部符合' : '範圍內 ' + g.hours + ' 小時中有 ' + g.hits + ' 小時符合（只有符合的小時會不採用；中間相隔 3 小時以內的合併成一段顯示）') + '，' + vr + '。' +
        (g.noted ? '其中 ' + g.noted + ' 小時月報有寫備註。' : '月報這段沒有寫備註。') + '</div>';
      h += '<div class="what">' + esc(RULE_ADV[g.rule] || '') + '</div>';
      if (!imp) h += '<div class="imp hint" data-imp="' + esc(g.key) + '">採用與不採用的差別計算中…</div>';
      else h += impHtml(g, imp);
      if (stt !== 'keep') h += '<div class="adv"><b>建議：</b>' + (stt === 'pending' ? '系統已先把這段的 ' + fl + ' 設為不採用。' : '') + '如果您確認是儀器異常，按「確認不採用」；如果這是真實狀況（例如附近施工、颱風），按「改回採用」。只有其中幾小時有問題的話，可以先改回採用，再到下方「手動新增不採用時段」只設定有問題的時間。</div>';
      h += '<div class="row">' + (stt !== 'exclude' ? '<button type="button" class="danger" data-sgset="exclude" data-k="' + esc(g.key) + '">確認不採用</button>' : '') +
        (stt !== 'keep' ? '<button type="button" data-sgset="keep" data-k="' + esc(g.key) + '">改回採用（這是真實數值）</button>' : '') +
        (stt !== 'pending' ? '<button type="button" data-sgset="reset" data-k="' + esc(g.key) + '">改回待確認</button>' : '') + '</div>';
      return h + '</div>';
    }).join('') + (sgShown.length > LIMIT ? '<p class="msg warn">共 ' + sgShown.length + ' 段，一次列出前 ' + LIMIT + ' 段，請用上方感測器或狀況篩選。「批次」按鈕仍會處理全部 ' + sgShown.length + ' 段。</p>' : '');
    fillImpacts();
  }
  function impHtml(g, imp) {
    var fl = g.fields.map(function (f) { return LABEL[f]; }).join('、');
    if (!imp.length) return '<div class="imp hint">這段採用或不採用，報表的日平均都一樣（四捨五入後相同）。</div>';
    return '<div class="imp"><b>' + fl + ' 採用與不採用時，報表的差別：</b><table><tr><th>日期</th><th>項目</th><th>採用時</th><th>不採用時</th></tr>' + imp.slice(0, 8).map(function (d) {
      return '<tr><td>' + Core.toRoc(d[0]) + '</td><td>' + esc(d[1]) + '</td><td>' + fmtV(d[2]) + '</td><td><b>' + fmtV(d[3]) + '</b></td></tr>';
    }).join('') + '</table>' + (imp.length > 8 ? '<span class="hint">…另有 ' + (imp.length - 8) + ' 個數值不同</span>' : '') + '</div>';
  }
  /** 先把卡片畫出來，再分批補上「採用與不採用的差別」，畫面不會卡住 */
  var impJob = 0;
  function fillImpacts() {
    var job = ++impJob;
    function step() {
      if (job !== impJob) return;
      var el = $('sgList').querySelector('[data-imp]');
      if (!el) return;
      var g = sgShown.filter(function (x) { return x.key === el.dataset.imp; })[0];
      if (g) { var tmp = document.createElement('div'); tmp.innerHTML = impHtml(g, suspectImpact(g)); el.replaceWith(tmp.firstChild); }
      else el.removeAttribute('data-imp');
      setTimeout(step, 0);
    }
    setTimeout(step, 0);
  }
  ['sgStatus', 'sgSensor', 'sgRule'].forEach(function (id) { $(id).addEventListener('change', function () { $('sgMsg').innerHTML = ''; renderSuspects(); }); });
  var sgSel = {}; // 勾選的段 key
  function toast(html, kind) {
    var t = $('toast');
    t.className = 'toast msg ' + (kind || 'ok'); t.innerHTML = html + ' <button type="button" id="toastX">關閉</button>'; t.hidden = false;
    clearTimeout(toast.tm); toast.tm = setTimeout(function () { t.hidden = true; }, 8000);
    $('toastX').onclick = function () { t.hidden = true; };
  }
  function setSuspect(keys, val) {
    if (state.loadError || !keys.length) return;
    var before = suspectDec(), after = {};
    Object.keys(before).forEach(function (k) { after[k] = before[k]; });
    keys.forEach(function (k) { if (val === 'reset') delete after[k]; else after[k] = val; });
    var groups = proc().groups.filter(function (g) { return keys.indexOf(g.key) >= 0; });
    var days = {};
    groups.forEach(function (g) { Core.daysBetween(g.from.slice(0, 10), g.to.slice(0, 10)).forEach(function (d) { days[g.id + '|' + d] = true; }); });
    var y = window.scrollY;
    document.body.classList.add('busy-cursor');
    return Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'suspect', value: after } }]).then(function () {
      state.meta.suspect = after; delete state.meta.suspectIgnore;
      var diff = recalcDiff(Object.keys(days), review(), review(), manual(), manual(), before, after);
      reapplyAuto();
      keys.forEach(function (k) { delete sgSel[k]; });
      renderSuspects();
      refreshReviewBadge();
      var n = proc().groups.filter(function (g) { return sgStatus(g) === 'pending'; }).length;
      $('suspectBadge').hidden = !n; $('suspectBadge').textContent = '異常 ' + n;
      window.scrollTo(0, y); // 保持原地，不跳回最上面
      var verb = (val === 'keep' ? '已改回採用 ' : val === 'exclude' ? '已確認不採用 ' : '已改回待確認 ') + keys.length + ' 段';
      var fmt = function (v) { return v === null || v === undefined ? '（空白）' : esc(v); };
      toast('<b>' + verb + '</b>。' + (diff.length ? '報表有 ' + diff.length + ' 個日平均改變' + (diff.length <= 3 ? '：' + diff.map(function (d) { return esc(d[0]) + ' ' + Core.toRoc(d[1]) + ' ' + esc(d[2]) + ' ' + fmt(d[3]) + ' → ' + fmt(d[4]); }).join('；') : '，可到「④ 產出報表」重新下載。') : '報表數值沒有改變。'));
      $('sgMsg').innerHTML = ''; // 不在清單上方插入內容，避免畫面位移
    }).catch(function (er) { toast('儲存失敗：' + esc(er.message || er), 'err'); })
      .then(function () { document.body.classList.remove('busy-cursor'); });
  }
  $('sgList').addEventListener('click', function (e) {
    var t = e.target; if (!t.dataset.sgset) return;
    t.disabled = true; t.textContent = '處理中…';
    setSuspect([t.dataset.k], t.dataset.sgset);
  });
  $('sgList').addEventListener('change', function (e) {
    var t = e.target; if (!t.dataset.sgsel) return;
    if (t.checked) sgSel[t.dataset.sgsel] = true; else delete sgSel[t.dataset.sgsel];
    t.closest('.sg').classList.toggle('picked', t.checked);
    updateSgSel();
  });
  function selKeys() { var shownK = {}; sgShown.forEach(function (g) { shownK[g.key] = true; }); return Object.keys(sgSel).filter(function (k) { return shownK[k]; }); }
  function updateSgSel() {
    var n = selKeys().length;
    $('sgSelN').textContent = n;
    ['sgSelX', 'sgSelK', 'sgSelR'].forEach(function (id) { $(id).disabled = !n; });
    var all = $('sgSelAll'); all.checked = n > 0 && n === sgShown.length; all.indeterminate = n > 0 && n < sgShown.length;
  }
  $('sgSelAll').addEventListener('change', function (e) {
    sgShown.forEach(function (g) { if (e.target.checked) sgSel[g.key] = true; else delete sgSel[g.key]; });
    $('sgList').querySelectorAll('input[data-sgsel]').forEach(function (cb) { cb.checked = e.target.checked; cb.closest('.sg').classList.toggle('picked', cb.checked); });
    updateSgSel();
  });
  $('sgSelX').addEventListener('click', function () { setSuspect(selKeys(), 'exclude'); });
  $('sgSelK').addEventListener('click', function () { setSuspect(selKeys(), 'keep'); });
  $('sgSelR').addEventListener('click', function () { setSuspect(selKeys(), 'reset'); });
  $('sgAllX').addEventListener('click', function () { setSuspect(sgShown.map(function (g) { return g.key; }), 'exclude'); });
  $('sgAllK').addEventListener('click', function () { setSuspect(sgShown.map(function (g) { return g.key; }), 'keep'); });
  $('sgAllR').addEventListener('click', function () { setSuspect(sgShown.map(function (g) { return g.key; }), 'reset'); });

  // 門檻設定
  var AUTO_FORM = [
    ['LEQ999', 'Leq 錯誤碼：大於等於', 'v', 'dB'], ['LEQHIGH', 'Leq 過高：大於', 'v', 'dB'], ['LEQLOW', 'Leq 過低：小於', 'v', 'dB'],
    ['PMCAP', 'PM10／PM2.5 接近儀器上限：大於等於', 'v', 'μg/m³'], ['HUM100', '濕度：大於', 'v', '%'],
    ['TMPRANGE', '溫度：低於', 'lo', '℃，或高於', 'hi', '℃'], ['WSHIGH', '風速：大於', 'v', 'm/s'], ['WDBAD', '風向：大於', 'v', '度'],
    ['RAHIGH', '時雨量：大於', 'v', 'mm'], ['STUCK', 'PM10、PM2.5、TVOC、濕度同值連續：大於等於', 'v', '小時']
  ];
  function renderAutoForm() {
    var c = M.autoCfg(settings().auto);
    $('autoForm').innerHTML = AUTO_FORM.map(function (x) {
      var k = x[0], h = '<div class="row"><label><input type="checkbox" data-ak="' + k + '" data-af="on"' + (c[k].on ? ' checked' : '') + '> ' + esc(x[1]) + '</label> ';
      h += '<input type="number" step="any" class="num" data-ak="' + k + '" data-af="' + x[2] + '" value="' + esc(c[k][x[2]]) + '"> ' + esc(x[3]);
      if (x[4]) h += ' <input type="number" step="any" class="num" data-ak="' + k + '" data-af="' + x[4] + '" value="' + esc(c[k][x[4]]) + '"> ' + esc(x[5]);
      return h + '</div>';
    }).join('');
  }
  $('autoSave').addEventListener('click', function () {
    if (state.loadError) return;
    var auto = {}, bad = [];
    $('autoForm').querySelectorAll('[data-ak]').forEach(function (el) {
      var k = el.dataset.ak, f = el.dataset.af;
      auto[k] = auto[k] || {};
      if (f === 'on') auto[k].on = el.checked;
      else { var v = Number(el.value); if (el.value === '' || !isFinite(v)) bad.push(k); else auto[k][f] = v; }
    });
    if (bad.length) { $('autoMsg').innerHTML = '<span class="msg err">有門檻沒有填數字，請檢查。</span>'; return; }
    if (auto.STUCK.v < 2) { $('autoMsg').innerHTML = '<span class="msg err">同值連續小時至少要 2。</span>'; return; }
    var v = {}; Object.keys(settings()).forEach(function (k) { v[k] = settings()[k]; }); v.auto = auto;
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).then(reload).then(function () {
      renderAutoForm(); renderSuspects();
      $('autoMsg').innerHTML = '<span class="msg ok">已儲存並重新判定。門檻改變後段落範圍可能不同，新出現的段落會列為待確認。</span>';
    }).catch(function (er) { $('autoMsg').innerHTML = '<span class="msg err">儲存失敗：' + esc(er.message || er) + '</span>'; });
  });
  $('autoReset').addEventListener('click', function () {
    var c = M.autoCfg(null);
    $('autoForm').querySelectorAll('[data-ak]').forEach(function (el) {
      var k = el.dataset.ak, f = el.dataset.af;
      if (f === 'on') el.checked = c[k].on; else el.value = c[k][f];
    });
    $('autoMsg').innerHTML = '<span class="msg info">已填回出廠預設，按「儲存並重新判定」才會生效。</span>';
  });

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

  // ---------------- 資料缺漏與無效測值、總覽 ----------------
  var gapCache = null;
  function gaps() { if (!gapCache) gapCache = M.dataIssues(state.chunks, state.sensors); return gapCache; }
  var GAP_KIND = { month: '整月沒有資料', missing: '缺少小時', blank: '測值空白或無效' };
  function refreshGapBadge() {
    var n = gaps().filter(function (g) { return g.kind !== 'blank'; }).length;
    $('gapBadge').hidden = !n; $('gapBadge').textContent = '缺 ' + n;
    $('gapBadge').title = n + ' 段資料缺漏（整月沒有資料或缺少小時）';
    renderOverview();
  }
  function renderGaps() {
    var all = gaps(), kk = $('gpKind').value, ks = $('gpSensor').value, km = $('gpMonth').value;
    var bs = {}, bm = {};
    all.forEach(function (g) { if (!kk || g.kind === kk) { bs[g.id] = (bs[g.id] || 0) + 1; bm[g.month] = (bm[g.month] || 0) + 1; } });
    $('gpSensor').innerHTML = '<option value="">全部</option>' + Object.keys(bs).sort().map(function (id) { return '<option value="' + esc(id) + '">' + esc(id + ' ' + sensorName(id)) + '（' + bs[id] + '）</option>'; }).join('');
    $('gpMonth').innerHTML = '<option value="">全部</option>' + Object.keys(bm).sort().map(function (m) { return '<option value="' + m + '">' + esc(Core.toRoc(m + '-01').slice(0, -3)) + '（' + bm[m] + '）</option>'; }).join('');
    $('gpSensor').value = bs[ks] ? ks : ''; $('gpMonth').value = bm[km] ? km : '';
    ks = $('gpSensor').value; km = $('gpMonth').value;
    var list = all.filter(function (g) { return (!kk || g.kind === kk) && (!ks || g.id === ks) && (!km || g.month === km); });
    var c = { month: 0, missing: 0, blank: 0 }, hc = { month: 0, missing: 0, blank: 0 };
    all.forEach(function (g) { c[g.kind]++; hc[g.kind] += g.hours; });
    $('gpSummary').innerHTML = '<div class="msg ' + (c.month || c.missing ? 'warn' : 'info') + '">整月沒有資料 <b>' + c.month + '</b> 段、缺少小時 <b>' + c.missing + '</b> 段（' + hc.missing + ' 小時）、測值空白或無效 <b>' + c.blank + '</b> 段（' + hc.blank + ' 小時）。' +
      (c.month || c.missing ? '「整月沒有資料」「缺少小時」請確認是不是漏匯入或月報本身就缺；要補的話重新匯入該月月報即可。感測器已撤掉或當時還沒裝的，請到「⑤ 感測器編號與名稱」設定停用日／啟用日，就不會再列出。' : '沒有缺少的月份或小時。') + '</div>';
    $('gpSum').textContent = ($('gpBox').open ? '收合清單' : '展開清單') + '（' + all.length + ' 段）';
    if (!list.length) { $('gpList').innerHTML = '<p class="hint">沒有符合條件的資料。</p>'; return; }
    var LIMIT = 300;
    $('gpList').innerHTML = '<table><tr><th>類型</th><th>感測器</th><th>時間</th><th>小時</th><th class="l">測項</th><th class="l">月報備註</th></tr>' + list.slice(0, LIMIT).map(function (g) {
      var fl = g.kind === 'month' ? '全部' : g.kind === 'missing' ? '整列沒有（' + g.fields.map(function (f) { return LABEL[f]; }).join('、') + '）' : g.fields.map(function (f) { return LABEL[f]; }).join('、');
      var nt = g.notes.length ? esc(g.notes.slice(0, 4).join('、') + (g.notes.length > 4 ? '…等 ' + g.notes.length + ' 種' : '')) + '<br><span class="hint">其中 ' + g.noted + ' 小時有寫備註</span>' : '<span class="hint">（沒有備註）</span>';
      return '<tr><td><span class="tag ' + (g.kind === 'blank' ? 'gray' : 'warn') + '">' + GAP_KIND[g.kind] + '</span></td><td>' + esc(g.id) + '<br><span class="hint">' + esc(sensorName(g.id)) + '</span></td><td>' + fmtTs(g.from) + (g.from === g.to ? '' : '<br>～ ' + fmtTs(g.to)) + '</td><td>' + g.hours + '</td><td class="l" style="white-space:normal;max-width:220px">' + fl + '</td><td class="l" style="white-space:normal;min-width:200px;max-width:340px">' + nt + '</td></tr>';
    }).join('') + '</table>' + (list.length > LIMIT ? '<p class="msg warn">共 ' + list.length + ' 段，只列出前 ' + LIMIT + ' 段，請用上方篩選。</p>' : '');
  }
  ['gpKind', 'gpSensor', 'gpMonth'].forEach(function (id) { $(id).addEventListener('change', renderGaps); });
  $('gpBox').addEventListener('toggle', function () { $('gpSum').textContent = ($('gpBox').open ? '收合清單' : '展開清單') + '（' + gaps().length + ' 段）'; });
  function pmRuleCounts() {
    var zero = 0, ratio = 0;
    state.chunks.forEach(function (c) {
      if (c.fields.indexOf('PM10') < 0 && c.fields.indexOf('PM25') < 0) return;
      c.rows.forEach(function (r) {
        var a = Core.validValue(r.v.PM10), b = Core.validValue(r.v.PM25);
        if (a === 0 || b === 0) zero++;
        if (a !== null && b !== null && a !== 0 && b !== 0 && b > a) ratio++;
      });
    });
    return { zero: zero, ratio: ratio };
  }
  function renderOverview() {
    if (!state.chunks || !state.chunks.length) { $('ovList').innerHTML = '<p class="hint">尚未匯入任何資料。</p>'; return; }
    var todo = M.reviewItems(state.chunks, review()).items.filter(function (it) { return it.status !== 'confirmed'; }).length;
    var sg = { pending: 0, exclude: 0, keep: 0 }; proc().groups.forEach(function (g) { sg[sgStatus(g)]++; });
    var gp = { month: 0, missing: 0, blank: 0 }, gh = { missing: 0, blank: 0 }; gaps().forEach(function (g) { gp[g.kind]++; if (gh[g.kind] !== undefined) gh[g.kind] += g.hours; });
    var pm = pmRuleCounts(), mn = manual().length;
    function jn(id, n, cls) { $(id).textContent = n ? n : ''; $(id).className = 'jn' + (cls ? ' ' + cls : ''); }
    jn('jnRv', todo); jn('jnSg', sg.pending, 'w'); jn('jnMn', mn, 'g'); jn('jnGp', gp.month + gp.missing, 'g');
    function item(target, cls, html) { if (!target) return '<div class="ov msg ' + cls + '">' + html + '</div>'; return '<button type="button" class="ov msg ' + cls + '" data-go="' + target + '">' + html + '</button>'; }
    $('ovList').innerHTML =
      item('rvCard', todo ? 'err' : 'ok', '① 月報備註時段：待確認 <b>' + todo + '</b> 筆' + (todo ? '（需要您確認）' : '（都確認完了）')) +
      item('suspectCard', sg.pending ? 'warn' : 'ok', '② 疑似異常（數值不合理）：待確認 <b>' + sg.pending + '</b> 段（目前預設不採用）、已確認不採用 ' + sg.exclude + ' 段、已改回採用 ' + sg.keep + ' 段') +
      item('mnCard', 'info', '③ 手動不採用時段：' + mn + ' 段') +
      item('', 'info', '④ 自動不計的測值：PM 為 0 共 ' + pm.zero + ' 小時、PM2.5 大於 PM10 共 ' + pm.ratio + ' 小時（兩者不計）。這兩項可在「④ 產出報表」取消勾選。') +
      item('gapCard', gp.month || gp.missing ? 'warn' : 'info', '⑤ 資料缺漏（清單在頁面最下方，預設收合）：整月沒有資料 <b>' + gp.month + '</b> 段、缺少小時 <b>' + gp.missing + '</b> 段（' + gh.missing + ' 小時）；測值空白或無效 ' + gp.blank + ' 段（' + gh.blank + ' 小時，自動不計）');

  }
  $('ovList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-go]'); if (!b) return;
    setFold($(b.dataset.go), false);
    if (b.dataset.go === 'gapCard') $('gpBox').open = true;
    jumpTo($(b.dataset.go));
  });
  function renderManualList() {
    var list = manual();
    if (!list.length) { $('mnList').innerHTML = '<p class="hint">尚未設定。</p>'; return; }
    $('mnList').innerHTML = fold('mnlist', '<table><tr><th>感測器</th><th>從</th><th>到</th><th>測項</th><th class="l">原因</th><th>影響</th><th></th></tr>' + list.map(function (m) {
      var imp = M.manualImpact(state.chunks, m);
      return '<tr><td>' + esc(m.id) + '<br><span class="hint">' + esc(sensorName(m.id)) + '</span></td><td>' + fmtTs(m.from) + '</td><td>' + fmtTs(m.to) + '</td><td>' + m.fields.map(function (f) { return LABEL[f]; }).join('、') +
        '</td><td class="l">' + esc(m.reason || '') + '</td><td>' + imp.hours + ' 小時</td><td><button data-del="' + esc(m.uid) + '">刪除</button><span class="delc" data-for="' + esc(m.uid) + '" hidden> 確定刪除？<button class="danger" data-delyes="' + esc(m.uid) + '">確定</button><button data-delno="1">取消</button></span></td></tr>';
    }).join('') + '</table>', list.length, '段', 10);
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
      var cur = Store.current() || {};
      var data = { app: 'env-quarterly-report', version: window.ENV_APP_VERSION, exportedAt: new Date().toISOString(), project: { code: cur.code || '', name: cur.name || '' }, chunks: d.chunks, sensors: d.sensors, meta: d.meta };
      download(new Blob([JSON.stringify(data)], { type: 'application/json' }), '環境監測資料備份_' + (cur.code ? safeName(cur.code) + '_' : '') + stamp() + '.json');
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
      var cur = Store.current() || {}, bp = d.project || {};
      var diffP = bp.code !== undefined && (bp.code !== (cur.code || '') || bp.name !== (cur.name || ''));
      $('restoreMsg').innerHTML = '<span class="msg warn">備份檔含 ' + Object.keys(months).length + ' 個月、' + rows + ' 筆資料（' + esc(d.exportedAt || '') + '）' +
        (bp.code !== undefined ? '，來自計畫「' + esc((bp.code || '') + ' ' + (bp.name || '')) + '」' : '') + '。' +
        (diffP ? '<b>與目前計畫「' + esc((cur.code || '') + ' ' + (cur.name || '')) + '」不同，請確認是否還原到目前計畫。</b>' : '') +
        '還原會取代目前計畫的全部資料。 <button id="restoreYes" class="danger">確定還原</button> <button id="restoreNo">取消</button></span>';
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

  // ---------------- 儲存空間與清除 ----------------
  function fmtBytes(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function refreshStorage() {
    return Promise.all([Store.estimate(), Store.persisted()]).then(function (r) {
      var e = r[0], ps = r[1], h = '';
      var rows = state.chunks.reduce(function (a, c) { return a + c.rows.length; }, 0);
      h += '目前計畫：' + M.coverage(state.chunks).months.length + ' 個月、' + rows.toLocaleString() + ' 筆逐時資料。<br>';
      if (e && e.quota) {
        h += '本網站（全部計畫合計）已使用 <b>' + fmtBytes(e.usage) + '</b>，瀏覽器允許上限約 <b>' + fmtBytes(e.quota) + '</b>，還剩約 <b>' + fmtBytes(e.quota - e.usage) + '</b>（已用 ' + (e.usage / e.quota * 100).toFixed(e.usage / e.quota < 0.01 ? 2 : 1) + '%）。';
        h += '<br><span class="hint">上限是瀏覽器依硬碟剩餘空間估算的，硬碟空間變少時上限也會跟著變小。</span>';
      } else h += '這個瀏覽器無法查詢儲存空間（例如用本機檔案開啟時）。';
      h += '<br>持久保存：' + (ps === true ? '<b class="st-c">已開啟</b>（瀏覽器不會自動清掉資料）' : ps === false ? '<b class="st-p">尚未開啟</b>（硬碟空間很緊時，瀏覽器可能自動清掉資料）' : '此瀏覽器不支援查詢');
      $('storageInfo').innerHTML = h;
      $('persistBtn').hidden = ps === true;
    });
  }
  function autoPersist() { Store.persisted().then(function (p) { if (p === false) Store.persist().then(refreshStorage); }); }
  $('storageRefresh').addEventListener('click', refreshStorage);
  $('persistBtn').addEventListener('click', function () {
    Store.persist().then(function (ok) {
      refreshStorage();
      $('clrMsg').innerHTML = '';
      $('storageInfo').insertAdjacentHTML('beforeend', ok ? '<div class="msg ok">瀏覽器已同意持久保存。</div>' : '<div class="msg warn">瀏覽器這次沒有同意（Chrome 會依使用情況自動判斷）。把這個網站加入書籤、常用一陣子後可以再按一次；在那之前請定期下載備份。</div>');
    });
  });
  var clrMode = null;
  $('clrProj').addEventListener('click', function () {
    clrMode = 'proj'; $('clrBox').hidden = false;
    $('clrText').innerHTML = '確定要清除計畫「<b>' + esc(projLabel(Store.current())) + '</b>」的全部資料？（匯入的月報、確認結果、感測器名稱、設定都會清除；計畫本身保留）';
  });
  $('clrAll').addEventListener('click', function () {
    clrMode = 'all'; $('clrBox').hidden = false;
    $('clrText').innerHTML = '確定要清除<b>全部 ' + projList.length + ' 個計畫</b>與所有資料？清除後網站回到剛開始使用的狀態。';
  });
  $('clrNo').addEventListener('click', function () { $('clrBox').hidden = true; });
  $('clrYes').addEventListener('click', function () {
    if (state.loadError) return;
    $('clrMsg').innerHTML = '<div class="msg info">清除中…</div>'; $('clrYes').disabled = true;
    var job = clrMode === 'proj' ? Store.clearProjectData()
      : Store.removeAll().then(function () { return Store.open(); }).then(function () { return renderProjects(); });
    job.then(function () { resetViews(); return reload(); }).then(function () {
      $('clrBox').hidden = true; $('clrYes').disabled = false; refreshStorage();
      $('clrMsg').innerHTML = '<div class="msg ok">' + (clrMode === 'proj' ? '目前計畫的資料已清除。' : '全部計畫與資料已清除。') + '</div>';
    }).catch(function (e) { $('clrYes').disabled = false; $('clrMsg').innerHTML = '<div class="msg err">清除失敗：' + esc(e.message || e) + '</div>'; });
  });

  // ---------------- 噪音日／晚／夜時段設定 ----------------
  function isDefaultNoise(cfg) { return JSON.stringify(Core.noiseCfg(cfg)) === JSON.stringify(Core.noiseCfg(null)); }
  function renderNoiseNow() {
    var cfg = settings().noise, def = isDefaultNoise(cfg);
    $('noiseNow').innerHTML = '<h2>噪音時段（產出噪音報表前請確認）</h2><div class="' + (def ? 'info' : 'msg warn') + '">目前設定' + (def ? '（出廠預設）' : '（<b>已自訂</b>）') + '：' + esc(Core.describeNoise(cfg)) +
      '</div><div class="row"><button type="button" id="goNoise">到「⑦ 噪音時段設定」修改</button></div>';
    $('goNoise').onclick = function () { document.querySelector('.tabs button[data-tab="noise"]').click(); window.scrollTo(0, 0); };
  }
  var noiseDraft = null;
  var NKEYS = ['DAY', 'EVE', 'NIGHT'];
  var NOISE_PRESETS = {
    std: { name: '出廠預設（同日：日 06–20、晚 20–22、夜 00–06＋22–24）', cfg: Core.DEFAULT_NOISE },
    cross: { name: '夜間跨日（日 07–19、晚 19–22、夜 22–翌日 07）', cfg: { DAY: [{ fd: 0, fh: 7, td: 0, th: 19 }], EVE: [{ fd: 0, fh: 19, td: 0, th: 22 }], NIGHT: [{ fd: 0, fh: 22, td: 1, th: 7 }] } },
    cross2: { name: '夜間跨日（日 06–20、晚 20–22、夜 22–翌日 06）', cfg: { DAY: [{ fd: 0, fh: 6, td: 0, th: 20 }], EVE: [{ fd: 0, fh: 20, td: 0, th: 22 }], NIGHT: [{ fd: 0, fh: 22, td: 1, th: 6 }] } }
  };
  function hourOpts(sel, max) { var h = ''; for (var i = 0; i <= max; i++) h += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + Core.pad(i) + ':00</option>'; return h; }
  function dayOpts(sel) { return '<option value="0"' + (sel === 0 ? ' selected' : '') + '>當日</option><option value="1"' + (sel === 1 ? ' selected' : '') + '>翌日</option>'; }
  function renderNoiseForm(keepDraft) {
    if (!keepDraft || !noiseDraft) noiseDraft = JSON.parse(JSON.stringify(Core.noiseCfg(settings().noise)));
    var h = '';
    NKEYS.forEach(function (k) {
      h += '<div class="nperiod"><b>' + Core.NOISE_LABEL[k] + '</b>';
      noiseDraft[k].forEach(function (g, i) {
        h += '<div class="row nseg">' + (i ? '＋ ' : '') + '<select data-nk="' + k + '" data-ni="' + i + '" data-nf="fd">' + dayOpts(g.fd) + '</select>' +
          '<select data-nk="' + k + '" data-ni="' + i + '" data-nf="fh">' + hourOpts(g.fh, 23) + '</select> ～ ' +
          '<select data-nk="' + k + '" data-ni="' + i + '" data-nf="td">' + dayOpts(g.td) + '</select>' +
          '<select data-nk="' + k + '" data-ni="' + i + '" data-nf="th">' + hourOpts(g.th, 24) + '</select>' +
          (noiseDraft[k].length > 1 ? ' <button type="button" data-ndel="' + k + '|' + i + '">刪除這段</button>' : '') + '</div>';
      });
      if (noiseDraft[k].length < 3) h += '<button type="button" data-nadd="' + k + '">＋ 再加一段</button>';
      h += '</div>';
    });
    $('noiseForm').innerHTML = h;
    var chk = Core.checkNoise(noiseDraft);
    var saved = settings().noise, html = '<div class="' + (isDefaultNoise(saved) ? 'info' : 'msg warn') + '">目前計畫已儲存的設定' + (isDefaultNoise(saved) ? '＝<b>出廠預設</b>（日 06–20、晚 20–22、夜＝當日 00–06 加 22–24，和原本 Access 報表相同）' : '＝<b>已自訂</b>：' + esc(Core.describeNoise(saved))) + '</div>' + '<div class="info">下方編輯中的設定，以 8/1 為例：' + esc(Core.describeNoise(noiseDraft)) + '<br><span class="hint">「結束」那一點不含在內，例如 06:00～20:00＝06 點到 19 點共 14 小時。24:00＝隔天 00:00。</span></div>';
    if (chk.errors.length) html += '<div class="msg err">' + chk.errors.map(esc).join('<br>') + '</div>';
    if (chk.warnings.length) html += '<div class="msg warn">' + chk.warnings.map(esc).join('<br>') + '</div>';
    $('noiseCheck').innerHTML = html;
    $('noiseSave').disabled = !chk.ok || !!state.loadError;
  }
  $('noiseForm').addEventListener('change', function (e) {
    var t = e.target; if (!t.dataset.nk) return;
    noiseDraft[t.dataset.nk][+t.dataset.ni][t.dataset.nf] = +t.value;
    $('noiseMsg').innerHTML = ''; renderNoiseForm(true);
  });
  $('noiseForm').addEventListener('click', function (e) {
    var t = e.target;
    if (t.dataset.nadd) { var k = t.dataset.nadd, last = noiseDraft[k][noiseDraft[k].length - 1]; noiseDraft[k].push({ fd: last.td, fh: last.th % 24, td: last.td, th: Math.min(24, last.th % 24 + 1) }); renderNoiseForm(true); }
    if (t.dataset.ndel) { var p = t.dataset.ndel.split('|'); noiseDraft[p[0]].splice(+p[1], 1); renderNoiseForm(true); }
  });
  $('noisePresets').addEventListener('click', function (e) {
    var k = e.target.dataset.np; if (!k) return;
    noiseDraft = JSON.parse(JSON.stringify(NOISE_PRESETS[k].cfg)); renderNoiseForm(true);
    $('noiseMsg').innerHTML = '<span class="msg info">已套用「' + esc(NOISE_PRESETS[k].name) + '」，按「儲存時段設定」才會生效。</span>';
  });
  $('noisePresets').innerHTML = Object.keys(NOISE_PRESETS).map(function (k) { return '<button type="button" data-np="' + k + '">' + esc(NOISE_PRESETS[k].name) + '</button>'; }).join('');
  $('noiseSave').addEventListener('click', function () {
    if (state.loadError || !Core.checkNoise(noiseDraft).ok) return;
    var v = {}; Object.keys(settings()).forEach(function (k) { v[k] = settings()[k]; }); v.noise = JSON.parse(JSON.stringify(noiseDraft));
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).then(reload).then(function () {
      renderNoiseForm();
      $('noiseMsg').innerHTML = '<span class="msg ok">已儲存（只套用在目前計畫）。之後下載的噪音報表會用新的時段計算。</span>';
    }).catch(function (er) { $('noiseMsg').innerHTML = '<span class="msg err">儲存失敗：' + esc(er.message || er) + '</span>'; });
  });

  // ---------------- ⑧ 盒鬚圖 ----------------
  var BX = window.EnvBox, bxResult = null;
  var collator = new Intl.Collator('zh-Hant-TW', { numeric: true });
  function bxMode() { var r = document.querySelector('input[name=bxMode]:checked'); return r ? r.value : 'month'; }
  document.querySelectorAll('input[name=bxMode]').forEach(function (r) {
    r.addEventListener('change', function () { document.querySelectorAll('[data-bx]').forEach(function (el) { el.hidden = el.dataset.bx !== bxMode(); }); bxDirty(); });
  });
  function bxRange(P) {
    P = P || 'bx';
    var r0 = document.querySelector('input[name=' + P + 'Mode]:checked'), md = r0 ? r0.value : 'month', ms = allMonths();
    if (!ms.length) return { error: '尚未匯入資料。' };
    var end = function (m) { return m + '-' + daysInMonth(m); };
    if (md === 'month') { var m = $(P + 'Month').value; return m ? { from: m + '-01', to: end(m), label: ymRoc(m), title: rocMonth(m) } : { error: '請選擇月份。' }; }
    if (md === 'months') {
      var a = $(P + 'MFrom').value, b = $(P + 'MTo').value;
      if (a > b) return { error: '起始月份晚於結束月份。' };
      return { from: a + '-01', to: end(b), label: ymRoc(a) + '-' + ymRoc(b), title: rocMonth(a) + '～' + rocMonth(b) };
    }
    if (md === 'quarters') {
      var y1 = Number($(P + 'QY1').value), q1 = Number($(P + 'Q1').value), y2 = Number($(P + 'QY2').value), q2 = Number($(P + 'Q2').value);
      if (!(y1 >= 1 && y2 >= 1)) return { error: '請輸入民國年。' };
      var r1 = Core.quarterRange(y1, q1), r2 = Core.quarterRange(y2, q2);
      if (r1.from > r2.from) return { error: '起始季別晚於結束季別。' };
      return { from: r1.from, to: r2.to, label: y1 + 'Q' + q1 + (r1.from === r2.from ? '' : '-' + y2 + 'Q' + q2), title: y1 + '年第' + q1 + '季' + (r1.from === r2.from ? '' : '～' + y2 + '年第' + q2 + '季') };
    }
    var f = $(P + 'DFrom').value, t = $(P + 'DTo').value;
    if (!f || !t) return { error: '請選擇起訖日期。' };
    if (f > t) return { error: '起始日期晚於結束日期。' };
    return { from: f, to: t, label: dRoc(f) + '-' + dRoc(t), title: Core.toRoc(f) + '～' + Core.toRoc(t) };
  }
  function bxSet() { return settings().box || {}; }
  function bxSave(patch) {
    if (state.loadError) return;
    var v = {}; Object.keys(settings()).forEach(function (k) { v[k] = settings()[k]; });
    var b = {}; Object.keys(bxSet()).forEach(function (k) { b[k] = bxSet()[k]; });
    Object.keys(patch).forEach(function (k) { b[k] = patch[k]; });
    v.box = b; state.meta.settings = v;
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).catch(function () {});
  }
  /** 圖上用的感測器名稱：名稱重複時加上編號，避免圖例／盒子分不出來 */
  function plotNames(ids) {
    var c = {}, out = {};
    ids.forEach(function (id) { var n = sensorName(id); c[n] = (c[n] || 0) + 1; });
    ids.forEach(function (id) { var n = sensorName(id); out[id] = c[n] > 1 ? n + '（' + reportId(id) + '）' : n; });
    return out;
  }
  function bxFieldKey(x) { return x.f + (x.period ? '_' + x.period : ''); }
  var bxFormReady = false;
  function renderBoxForm() {
    var ms = allMonths(), bs = bxSet();
    var opts = ms.map(function (m) { return '<option value="' + m + '">' + rocMonth(m) + '</option>'; }).join('');
    ['bxMonth', 'bxMFrom', 'bxMTo'].forEach(function (id) { var k = $(id).value; $(id).innerHTML = opts; if (k && ms.indexOf(k) >= 0) $(id).value = k; });
    if (ms.length) {
      if (!$('bxMonth').value || ms.indexOf($('bxMonth').value) < 0) $('bxMonth').value = ms[ms.length - 1];
      if (!bxFormReady) { $('bxMonth').value = ms[ms.length - 1]; $('bxMFrom').value = ms[0]; $('bxMTo').value = ms[ms.length - 1]; }
      var roc = function (m) { return Number(m.slice(0, 4)) - 1911; }, q = function (m) { return Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1; };
      if (!$('bxQY1').value) { $('bxQY1').value = roc(ms[0]); $('bxQ1').value = q(ms[0]); $('bxQY2').value = roc(ms[ms.length - 1]); $('bxQ2').value = q(ms[ms.length - 1]); }
    }
    // 測項
    var offF = bs.offFields || [];
    $('bxFields').innerHTML = BX.BOX_FIELDS.map(function (x) {
      var k = bxFieldKey(x);
      return '<label class="bf"><input type="checkbox" data-bxf="' + k + '"' + (offF.indexOf(k) < 0 ? ' checked' : '') + '> ' + esc(x.title) + '</label>';
    }).join('');
    // 感測器（有盒鬚圖測項的）
    var off = bs.offSensors || [], list = allSensorMeta().filter(function (s) {
      var fl = {}; state.chunks.forEach(function (c) { if (c.id === s.id) c.fields.forEach(function (f) { fl[f] = true; }); });
      return BX.BOX_FIELDS.some(function (x) { return fl[x.f]; });
    }).sort(function (a, b) { return collator.compare(a.name, b.name); });
    $('bxSensors').innerHTML = list.length ? list.map(function (s) {
      return '<label><input type="checkbox" data-bxs="' + esc(s.id) + '"' + (off.indexOf(s.id) < 0 ? ' checked' : '') + '> ' + esc(s.name) + ' <span class="hint">' + esc(s.id) + '</span></label>';
    }).join('') : '<p class="hint">尚未匯入任何資料。</p>';
    // 圖的設定
    if (!bxFormReady) {
      if (typeof bs.title === 'boolean') $('bxTitle').checked = bs.title;
      if (typeof bs.yNums === 'boolean') $('bxYNums').checked = bs.yNums;
      if (typeof bs.outliers === 'boolean') $('bxOut').checked = bs.outliers;
      if (typeof bs.xTitle === 'string' && bs.xTitle) $('bxXTitle').value = bs.xTitle;
    }
    var yr = bs.yRange || {};
    $('bxYRange').innerHTML = '<table><tr><th class="l">測項</th><th>Y 最小</th><th>Y 最大</th></tr>' + BX.BOX_FIELDS.map(function (x) {
      var k = bxFieldKey(x), v = yr[k] || {};
      return '<tr><td class="l">' + esc(x.title) + '</td><td><input type="number" step="any" class="num" data-bxy="' + k + '|min" value="' + (typeof v.min === 'number' ? v.min : '') + '"></td><td><input type="number" step="any" class="num" data-bxy="' + k + '|max" value="' + (typeof v.max === 'number' ? v.max : '') + '"></td></tr>';
    }).join('') + '</table>';
    bxFormReady = true;
  }
  function bxDirty() { if (bxResult) { bxResult = null; $('bxXlsx').disabled = true; $('bxPngs').disabled = true; $('bxMsg').innerHTML = '<div class="msg info">設定已變更，請重新按「產生盒鬚圖」。</div>'; } }
  $('tab-box').addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.bxs !== undefined || t.dataset.bxs) bxSave({ offSensors: Array.prototype.map.call(document.querySelectorAll('[data-bxs]:not(:checked)'), function (x) { return x.dataset.bxs; }) });
    if (t.dataset.bxf) bxSave({ offFields: Array.prototype.map.call(document.querySelectorAll('[data-bxf]:not(:checked)'), function (x) { return x.dataset.bxf; }) });
    if (t.dataset.bxy) {
      var yr = {}; document.querySelectorAll('[data-bxy]').forEach(function (x) { var p = x.dataset.bxy.split('|'), n = Number(x.value); if (x.value !== '' && isFinite(n)) { (yr[p[0]] = yr[p[0]] || {})[p[1]] = n; } });
      bxSave({ yRange: yr });
    }
    if (t.id === 'bxTitle' || t.id === 'bxYNums' || t.id === 'bxOut' || t.id === 'bxXTitle') bxSave({ title: $('bxTitle').checked, yNums: $('bxYNums').checked, outliers: $('bxOut').checked, xTitle: $('bxXTitle').value.trim() || '感測器' });
    bxDirty();
  });
  $('bxAll').addEventListener('click', function () { document.querySelectorAll('[data-bxs]').forEach(function (x) { x.checked = true; }); bxSave({ offSensors: [] }); bxDirty(); });
  $('bxNone').addEventListener('click', function () { document.querySelectorAll('[data-bxs]').forEach(function (x) { x.checked = false; }); bxSave({ offSensors: Array.prototype.map.call(document.querySelectorAll('[data-bxs]'), function (x) { return x.dataset.bxs; }) }); bxDirty(); });

  /** 依目前設定整理每個測項、每台感測器的逐時有效數值 */
  function bxCollect(r) {
    var zero = $('optPmZero').checked ? Core.ZERO_INVALID : [], ratio = $('optPmRatio').checked;
    var hp = BX.hourPeriods(Core.noiseCfg(settings().noise));
    var on = {}; document.querySelectorAll('[data-bxs]:checked').forEach(function (x) { on[x.dataset.bxs] = true; });
    var fOn = {}; document.querySelectorAll('[data-bxf]:checked').forEach(function (x) { fOn[x.dataset.bxf] = true; });
    var yr = bxSet().yRange || {};
    var sensors = proc().sensors.filter(function (s) { return on[s.id]; }).sort(function (a, b) { return collator.compare(sensorName(a.id), sensorName(b.id)); });
    var from = r.from + ' 00:00', to = r.to + ' 23:59';
    var charts = [], pn = plotNames(sensors.map(function (s) { return s.id; }));
    BX.BOX_FIELDS.forEach(function (x) {
      var k = bxFieldKey(x); if (!fOn[k]) return;
      var groups = [], empty = [];
      sensors.forEach(function (s) {
        if (s.fields.indexOf(x.f) < 0) return;
        var rows = [];
        s.rows.forEach(function (row) {
          if (row.ts < from || row.ts > to) return;
          if (x.period && hp[Number(row.ts.slice(11, 13))] !== x.period) return;
          if (!M.counted(row, x.f, zero, ratio)) return;
          rows.push({ ts: row.ts, v: row.v[x.f] });
        });
        if (!rows.length) { empty.push(pn[s.id]); return; }
        groups.push({ id: s.id, name: pn[s.id], rows: rows, stats: BX.boxStats(rows.map(function (q) { return q.v; })) });
      });
      var y = yr[k] || {};
      charts.push({ key: k, field: x.f, sheet: x.sheet, title: x.title, yTitle: x.y, xTitle: $('bxXTitle').value.trim() || '感測器', yMin: y.min, yMax: y.max,
        showTitle: $('bxTitle').checked, showYNums: $('bxYNums').checked, showOutliers: $('bxOut').checked, groups: groups, empty: empty });
    });
    return charts;
  }
  $('bxGo').addEventListener('click', function () {
    var r = bxRange();
    if (r.error) { $('bxMsg').innerHTML = '<div class="msg err">' + esc(r.error) + '</div>'; return; }
    $('bxMsg').innerHTML = '<div class="msg info">計算中…</div>';
    paint().then(function () {
      var all = bxCollect(r);
      var charts = all.filter(function (c) { return c.groups.length; });
      var skipped = all.filter(function (c) { return !c.groups.length; }).map(function (c) { return c.title; });
      if (!charts.length) { $('bxOut2').innerHTML = ''; $('bxMsg').innerHTML = '<div class="msg err">這個期間、勾選的感測器與測項沒有任何有效數值。</div>'; return; }
      bxResult = { range: r, charts: charts };
      var h = '';
      charts.forEach(function (c, i) {
        h += '<div class="card bxfig"><h3>' + esc(c.title) + ' <span class="hint">（' + c.groups.length + ' 台感測器，共 ' + c.groups.reduce(function (a, g) { return a + g.stats.n; }, 0).toLocaleString() + ' 個逐時有效數值）</span></h3>' +
          '<canvas data-bxc="' + i + '"></canvas><div class="row"><button type="button" data-bxpng="' + i + '">下載這張圖（PNG）</button>' +
          (c.empty.length ? '<span class="hint">沒有有效數值、未列入：' + esc(c.empty.join('、')) + '</span>' : '') + '</div></div>';
      });
      $('bxOut2').innerHTML = h;
      charts.forEach(function (c, i) { BX.drawBoxPlot(document.querySelector('canvas[data-bxc="' + i + '"]'), c, 1.5); });
      $('bxXlsx').disabled = false; $('bxPngs').disabled = false;
      var have = {}; allMonths().forEach(function (m) { have[m] = true; });
      var miss = M.monthsInRange(r).filter(function (m) { return !have[m]; });
      $('bxMsg').innerHTML = '<div class="msg ok">期間 <b>' + esc(r.title) + '</b>（' + Core.toRoc(r.from) + '～' + Core.toRoc(r.to) + '）：已產生 ' + charts.length + ' 張盒鬚圖。' +
        (skipped.length ? '沒有有效數值、未產生：' + esc(skipped.join('、')) + '。' : '') + '</div>' +
        (miss.length ? '<div class="msg warn">以下月份尚未匯入，圖中沒有這些月份的資料：' + miss.map(rocMonth).join('、') + '。</div>' : '');
    });
  });
  function bxFileBase() { var pc = (Store.current() && Store.current().code) ? safeName(Store.current().code) + '_' : ''; return pc + '盒鬚圖_' + bxResult.range.label; }
  function bxPngBlob(c) {
    return new Promise(function (res) { var cv = document.createElement('canvas'); BX.drawBoxPlot(cv, c, 3); cv.toBlob(function (b) { res(b); }, 'image/png'); });
  }
  $('bxOut2').addEventListener('click', function (e) {
    var i = e.target.dataset.bxpng; if (i === undefined || !bxResult) return;
    var c = bxResult.charts[+i];
    bxPngBlob(c).then(function (b) { download(b, bxFileBase() + '_' + safeName(c.title) + '.png'); });
  });
  $('bxPngs').addEventListener('click', function () {
    if (!bxResult) return;
    var zip = new window.JSZip(), btn = $('bxPngs'), old = btn.textContent; btn.disabled = true; btn.textContent = '產生中…';
    bxResult.charts.reduce(function (p, c, i) { return p.then(function () { return bxPngBlob(c).then(function (b) { zip.file((i + 1) + '_' + safeName(c.title) + '.png', b); }); }); }, Promise.resolve())
      .then(function () { return zip.generateAsync({ type: 'blob' }); })
      .then(function (b) { download(b, bxFileBase() + '_圖片.zip'); })
      .catch(function (er) { $('bxMsg').innerHTML = '<div class="msg err">圖片產生失敗：' + esc(er.message || er) + '</div>'; })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  });
  $('bxXlsx').addEventListener('click', function () {
    if (!bxResult) return;
    var btn = $('bxXlsx'), old = btn.textContent; btn.disabled = true; btn.textContent = '產生中…';
    var nRows = bxResult.charts.reduce(function (a, c) { return a + c.groups.reduce(function (b, g) { return b + g.rows.length; }, 0); }, 0);
    $('bxMsg').insertAdjacentHTML('beforeend', '<div class="msg info" id="bxWait">Excel 產生中（共 ' + nRows.toLocaleString() + ' 筆逐時數值' + (nRows > 300000 ? '，資料較多，大約需要 ' + Math.max(10, Math.round(nRows / 25000)) + ' 秒' : '') + '），請稍候…</div>');
    var r = bxResult.range, cur = Store.current() || {};
    var info = ['盒鬚圖資料（' + (cur.code ? cur.code + ' ' : '') + (cur.name || '') + '）',
      '期間：' + r.title + '（' + Core.toRoc(r.from) + '～' + Core.toRoc(r.to) + '）',
      '數值：每台感測器的逐時有效數值（和報表相同：異常值、空白、PM 為 0、PM2.5 大於 PM10、備註時段／疑似異常／手動設為不採用的小時都不列入）。',
      '噪音：逐時 Leq 依「⑦ 噪音時段設定」的整點歸入日間／晚間／夜間。',
      '盒鬚圖：盒子為第一四分位數到第三四分位數（四分位數計算方式「包含中位數」，同 Excel QUARTILE.INC），中間線為中位數；鬚延伸到 1.5 倍四分位距內最遠的數值；' + ($('bxOut').checked ? '離群值以圓點表示。' : '不顯示離群值。'),
      '每個測項工作表：左邊是 Excel 盒鬚圖（需 Excel 2016 以上或 Microsoft 365），右邊是資料（感測器、日期時間、數值）。修改或刪除右邊的數值，圖會跟著更新。',
      '「統計」工作表列出每台感測器的有效小時數、最小值、四分位數、中位數、最大值、鬚的位置與平均值。',
      '產生時間：' + new Date().toLocaleString('zh-TW')];
    BX.buildBoxWorkbook(ExcelJS, window.JSZip, bxResult.charts, info, window.ENV_BOX_STYLE).then(function (buf) {
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), bxFileBase() + '_' + stamp() + '.xlsx');
    }).catch(function (er) { $('bxMsg').innerHTML = '<div class="msg err">Excel 產生失敗：' + esc(er.message || er) + '</div>'; })
      .then(function () { btn.disabled = false; btn.textContent = old; if ($('bxWait')) $('bxWait').remove(); });
  });

  // ---------------- ⑨ 環境部比對趨勢圖 ----------------
  var TR = window.EnvTrend, trResult = null, trReady = false;
  function fillRangeForm(P, ready) {
    var ms = allMonths(), opts = ms.map(function (m) { return '<option value="' + m + '">' + rocMonth(m) + '</option>'; }).join('');
    [P + 'Month', P + 'MFrom', P + 'MTo'].forEach(function (id) { var k = $(id).value; $(id).innerHTML = opts; if (k && ms.indexOf(k) >= 0) $(id).value = k; });
    if (!ms.length) return;
    if (!ready || ms.indexOf($(P + 'Month').value) < 0) $(P + 'Month').value = ms[ms.length - 1];
    if (!ready) { $(P + 'MFrom').value = ms[0]; $(P + 'MTo').value = ms[ms.length - 1]; }
    var roc = function (m) { return Number(m.slice(0, 4)) - 1911; }, q = function (m) { return Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1; };
    if (!$(P + 'QY1').value) { $(P + 'QY1').value = roc(ms[0]); $(P + 'Q1').value = q(ms[0]); $(P + 'QY2').value = roc(ms[ms.length - 1]); $(P + 'Q2').value = q(ms[ms.length - 1]); }
  }
  document.querySelectorAll('input[name=trMode]').forEach(function (r) {
    r.addEventListener('change', function () { var v = document.querySelector('input[name=trMode]:checked').value; document.querySelectorAll('[data-tr]').forEach(function (el) { el.hidden = el.dataset.tr !== v; }); trDirty(); });
  });
  function trSet() { return settings().trend || {}; }
  function trSave(patch) {
    if (state.loadError) return Promise.resolve();
    var v = {}; Object.keys(settings()).forEach(function (k) { v[k] = settings()[k]; });
    var b = {}; Object.keys(trSet()).forEach(function (k) { b[k] = trSet()[k]; });
    Object.keys(patch).forEach(function (k) { b[k] = patch[k]; });
    v.trend = b; state.meta.settings = v;
    return Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'settings', value: v } }]).catch(function () {});
  }
  // 環境部資料：meta 'moe|測站編號|YYYY-MM'
  function moeChunks(siteid) {
    return Object.keys(state.meta).filter(function (k) { return k.indexOf('moe|') === 0 && (!siteid || k.split('|')[1] === String(siteid)); }).map(function (k) { return state.meta[k]; });
  }
  function moeSites() { return state.meta.moeSites || {}; } // {siteid: {label}}
  function stationList() {
    var list = (state.meta.moeStations || TR.FALLBACK_STATIONS).slice(), have = {};
    list.forEach(function (s) { have[s.siteid] = true; });
    moeChunks().forEach(function (c) { if (!have[c.siteid]) { have[c.siteid] = true; list.push({ siteid: c.siteid, sitename: c.sitename || c.siteid, county: c.county || '', sitetype: '' }); } });
    return list;
  }
  function curSite() { return String(trSet().site || '33'); }
  function siteInfo(id) { return stationList().filter(function (s) { return s.siteid === String(id); })[0] || { siteid: String(id), sitename: String(id), county: '' }; }
  function siteLabel(id) { var l = (moeSites()[id] || {}).label; return (l || '').trim() || '環境部' + siteInfo(id).sitename + '測站'; }
  // 舊版只存彰化站 PM10、PM2.5（meta 'moenv'）→ 轉成新格式
  function migrateMoenv() {
    var old = state.meta.moenv;
    if (!old || state.loadError) return Promise.resolve(false);
    var ops = [];
    TR.migrateLegacy(old).forEach(function (c) {
      var k = 'moe|' + c.siteid + '|' + c.month, ex = state.meta[k];
      var m = ex ? TR.mergeChunk(c, ex).chunk : c; // 已有新格式的資料時以新格式為準
      ops.push({ store: 'meta', type: 'put', value: { key: k, value: m } });
    });
    var sites = {}; Object.keys(moeSites()).forEach(function (k) { sites[k] = moeSites()[k]; });
    if (old.label && !(sites['33'] || {}).label) sites['33'] = { label: old.label };
    ops.push({ store: 'meta', type: 'put', value: { key: 'moeSites', value: sites } });
    ops.push({ store: 'meta', type: 'delete', key: 'moenv' });
    return Store.writeBatch(ops).then(reload).then(function () { return true; });
  }
  function renderSiteSelect() {
    var list = stationList(), cur = curSite(), cnt = {};
    moeChunks().forEach(function (c) { cnt[c.siteid] = (cnt[c.siteid] || 0) + 1; });
    var by = {}; list.forEach(function (s) { (by[s.county || '其他'] = by[s.county || '其他'] || []).push(s); });
    $('moeSite').innerHTML = Object.keys(by).map(function (cty) {
      return '<optgroup label="' + esc(cty) + '">' + by[cty].map(function (s) { return '<option value="' + esc(s.siteid) + '">' + esc(s.sitename) + '（' + esc(s.sitetype || '測站') + '）' + (cnt[s.siteid] ? '　✔ 已有 ' + cnt[s.siteid] + ' 個月' : '') + '</option>'; }).join('') + '</optgroup>';
    }).join('');
    $('moeSite').value = cur;
    if ($('moeSite').value !== cur) { var o = document.createElement('option'); o.value = cur; o.textContent = cur; $('moeSite').appendChild(o); $('moeSite').value = cur; }
    $('moeStHint').textContent = state.meta.moeStations ? '共 ' + list.length + ' 個測站' : '目前只列出部分測站，按「更新測站清單」取得環境部全部測站';
    $('moeLabel').value = (moeSites()[cur] || {}).label || '';
    $('moeLabel').placeholder = '環境部' + siteInfo(cur).sitename + '測站';
  }
  function renderMoeList() {
    if ($('trRefs')) renderTrendRefs(); // 測站資料有變動時，比對測站清單一起更新
    var cs = moeChunks(curSite()).sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    if (!cs.length) { $('moeList').innerHTML = '<p class="hint">這個測站還沒有資料，請自動抓取或匯入 CSV。</p>'; $('moeDelRow').hidden = true; return; }
    var items = []; cs.forEach(function (c) { Object.keys(c.items).forEach(function (k) { if (items.indexOf(k) < 0) items.push(k); }); });
    var head = '<tr><th>月份</th><th>小時數</th>' + items.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') + '</tr>';
    var body = cs.map(function (c) {
      var sm = TR.chunkSummary(c), exp = daysInMonth(c.month) * 24;
      return '<tr><td>' + rocMonth(c.month) + '</td><td class="' + (sm.hours < exp ? 'part' : '') + '">' + sm.hours + ' / ' + exp + '</td>' + items.map(function (k) { var x = sm.items[k]; return '<td>' + (x ? x.valid : '') + '</td>'; }).join('') + '</tr>';
    }).join('');
    $('moeList').innerHTML = fold('moelist', '<table>' + head + body + '</table><p class="hint">各測項的數字＝有效小時數。黃色＝這個月的小時數不完整（環境部原始資料本來就缺，或還沒抓完整的月份）。</p>', cs.length, '個月', 12);
    $('moeDelM').innerHTML = cs.map(function (c) { return '<option value="' + c.month + '">' + rocMonth(c.month) + '</option>'; }).join('');
    $('moeDelM').value = cs[cs.length - 1].month;
    $('moeDelRow').hidden = false; $('moeDelConfirm').hidden = true;
  }
  function renderApiDefaults() {
    var mm = moeChunks(curSite()).map(function (c) { return c.month; }).sort(), ms = allMonths();
    var def = ms.length ? ms[ms.length - 1] : new Date().toISOString().slice(0, 7);
    if (!$('apiFrom').value) $('apiFrom').value = mm.length ? TR.nextMonth(mm[mm.length - 1]) : (ms[0] || def);
    if ($('apiFrom').value > def && ms.length) $('apiFrom').value = def;
    if (!$('apiTo').value) $('apiTo').value = def;
  }
  $('moeSite').addEventListener('change', function () {
    trSave({ site: $('moeSite').value }).then(function () { $('apiFrom').value = ''; $('apiTo').value = ''; renderSiteSelect(); renderMoeList(); renderApiDefaults(); renderTrendItems(); trDirty(); $('apiMsg').innerHTML = ''; });
  });
  $('moeLabel').addEventListener('change', function () {
    var s = {}; Object.keys(moeSites()).forEach(function (k) { s[k] = moeSites()[k]; });
    s[curSite()] = { label: $('moeLabel').value.trim() };
    Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'moeSites', value: s } }]).then(reload).then(function () { renderTrendRefs(); trDirty(); });
  });
  function apiFetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error('環境部網站回應錯誤（HTTP ' + r.status + '）：' + t.slice(0, 150));
        try { return JSON.parse(t); } catch (e) { throw new Error('環境部回傳的不是 JSON：' + t.slice(0, 150)); }
      });
    }, function () { throw new Error('連不到環境部網站（可能是網路中斷、網址錯誤、金鑰無效，或環境部暫時停止服務）。'); });
  }
  var AI_HINT = '<br><span class="hint">給維護的 AI：網址與金鑰設定在 js/trend.js 的 DEFAULT_API、DEFAULT_KEY、STATIONS_API（測站資料集代碼＝aqx_p_（188＋測站編號），例外寫在 DATASET_OVERRIDE），說明見 README.md。</span>';
  $('moeStRefresh').addEventListener('click', function () {
    var btn = $('moeStRefresh'); btn.disabled = true; $('moeStHint').textContent = '取得中…';
    TR.fetchStations(apiFetchJson, TR.DEFAULT_KEY).then(function (list) {
      return Store.writeBatch([{ store: 'meta', type: 'put', value: { key: 'moeStations', value: list } }]).then(reload).then(function () { renderSiteSelect(); $('moeStHint').textContent = '已更新：共 ' + list.length + ' 個測站'; });
    }).catch(function (e) { $('moeStHint').textContent = ''; $('apiMsg').innerHTML = '<div class="msg err">測站清單取得失敗：' + esc(e.message) + AI_HINT + '</div>'; })
      .then(function () { btn.disabled = false; });
  });
  function saveChunks(newChunks) {
    var ops = [], add = 0, rep = 0;
    newChunks.forEach(function (c) {
      var k = 'moe|' + c.siteid + '|' + c.month, m = TR.mergeChunk(state.meta[k], c);
      add += m.added; rep += m.replaced;
      ops.push({ store: 'meta', type: 'put', value: { key: k, value: m.chunk } });
    });
    return (ops.length ? Store.writeBatch(ops).then(reload) : Promise.resolve()).then(function () { return { added: add, replaced: rep }; });
  }
  function moeImport(files) {
    if (state.loadError || !files.length) return;
    $('moeMsg').innerHTML = '<div class="msg info">讀取中…</div>';
    Promise.all(Array.prototype.map.call(files, function (f) { return f.text().then(function (t) { return { name: f.name, p: TR.parseMoenvCsv(t) }; }); })).then(function (res) {
      var chunks = [], lines = [], bad = [], sites = {};
      res.forEach(function (r) {
        if (!r.p.ok) { bad.push(esc(r.name) + '：' + esc(r.p.error)); return; }
        Object.keys(r.p.chunks).forEach(function (k) { chunks.push(r.p.chunks[k]); });
        Object.keys(r.p.stations).forEach(function (k) { sites[k] = r.p.stations[k]; });
        var ms = {}; Object.keys(r.p.chunks).forEach(function (k) { ms[r.p.chunks[k].month] = 1; });
        lines.push(esc(r.name) + '：' + Object.keys(r.p.stations).map(function (k) { return esc(r.p.stations[k].sitename || k); }).join('、') + '站，' + Object.keys(ms).sort().map(rocMonth).join('、') + '，共 ' + r.p.total + ' 筆（無效 ' + r.p.invalid + '）');
      });
      return saveChunks(chunks).then(function (st) {
        var sk = Object.keys(sites), other = sk.filter(function (k) { return k !== curSite(); });
        $('moeMsg').innerHTML = (lines.length ? '<div class="msg ok">已匯入：新增 ' + st.added + ' 筆、覆蓋 ' + st.replaced + ' 筆。<ul class="issues">' + lines.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>' : '') +
          (bad.length ? '<div class="msg err">' + bad.join('<br>') + '</div>' : '') +
          (other.length ? '<div class="msg info">檔案裡有 ' + other.map(function (k) { return esc(sites[k].sitename || k); }).join('、') + ' 站的資料，已分開存放；在上方「測站」選單選該站即可使用。</div>' : '');
        renderSiteSelect(); renderMoeList(); renderTrendItems(); trDirty();
      });
    }).catch(function (e) { $('moeMsg').innerHTML = '<div class="msg err">匯入失敗：' + esc(e.message || e) + '</div>'; });
  }
  $('moeFile').addEventListener('change', function () { moeImport(this.files); this.value = ''; });
  ['dragover', 'dragenter'].forEach(function (ev) { $('moeDrop').addEventListener(ev, function (e) { e.preventDefault(); $('moeDrop').classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { $('moeDrop').addEventListener(ev, function (e) { e.preventDefault(); $('moeDrop').classList.remove('over'); }); });
  $('moeDrop').addEventListener('drop', function (e) { moeImport(e.dataTransfer.files); });
  $('moeDel').addEventListener('click', function () { $('moeDelConfirm').hidden = false; });
  $('moeDelNo').addEventListener('click', function () { $('moeDelConfirm').hidden = true; });
  $('moeDelYes').addEventListener('click', function () {
    var m = $('moeDelM').value, sid = curSite();
    Store.writeBatch([{ store: 'meta', type: 'delete', key: 'moe|' + sid + '|' + m }]).then(reload).then(function () {
      $('apiMsg').innerHTML = '<div class="msg ok">已刪除 ' + esc(siteInfo(sid).sitename) + '站 ' + rocMonth(m) + ' 的資料。</div>'; renderSiteSelect(); renderMoeList(); renderTrendItems(); trDirty();
    });
  });
  function apiMonths() {
    var a = $('apiFrom').value, b = $('apiTo').value;
    if (!a || !b) return { error: '請選擇月份。' };
    if (a > b) return { error: '起始月份晚於結束月份。' };
    var ms = [], m = a; while (m <= b && ms.length < 36) { ms.push(m); m = TR.nextMonth(m); }
    return { months: ms, from: a, to: b };
  }
  $('apiTest').addEventListener('click', function () {
    var sid = curSite(), ym = $('apiTo').value || new Date().toISOString().slice(0, 7);
    $('apiMsg').innerHTML = '<div class="msg info">測試中…</div>';
    apiFetchJson(TR.apiUrl(TR.DEFAULT_API, { key: TR.DEFAULT_KEY, from: ym + '-01 00:00', to: TR.nextMonth(ym) + '-01 00:00', offset: 0, dataset: TR.datasetOf(sid) }).replace('limit=1000', 'limit=50')).then(function (j) {
      if (!Array.isArray(j)) throw new Error('回傳的不是資料清單：' + JSON.stringify(j).slice(0, 150));
      var p = TR.parseMoenvJson(j), st = Object.keys(p.stations).map(function (k) { return p.stations[k].sitename; });
      var items = {}; Object.keys(p.chunks).forEach(function (k) { Object.keys(p.chunks[k].items).forEach(function (i) { items[i] = 1; }); });
      if (!j.length) $('apiMsg').innerHTML = '<div class="msg warn">連線成功，但 ' + rocMonth(ym) + ' 沒有資料（環境部可能還沒有這個月，或這個測站沒有資料）。</div>';
      else if (Object.keys(p.stations).indexOf(sid) < 0) throw new Error('連線成功，但回傳的是 ' + st.join('、') + ' 站的資料，和選的測站對不上。');
      else $('apiMsg').innerHTML = '<div class="msg ok">連線成功：' + esc(st.join('、')) + '站（資料集 ' + esc(TR.datasetOf(sid).toUpperCase()) + '），測項有 ' + esc(Object.keys(items).join('、')) + '。</div>';
    }).catch(function (e) { $('apiMsg').innerHTML = '<div class="msg err">' + esc(e.message) + AI_HINT + '</div>'; });
  });
  $('apiGo').addEventListener('click', function () {
    if (state.loadError) return;
    var am = apiMonths(); if (am.error) { $('apiMsg').innerHTML = '<div class="msg err">' + esc(am.error) + '</div>'; return; }
    var sid = curSite(), btn = $('apiGo'); btn.disabled = true;
    var got = [], lines = [], failed = [];
    am.months.reduce(function (p, ym, i) {
      return p.then(function () {
        $('apiMsg').innerHTML = '<div class="msg info">抓取中：' + esc(siteInfo(sid).sitename) + '站 ' + rocMonth(ym) + '（' + (i + 1) + ' / ' + am.months.length + '）…</div>';
        return TR.fetchMonth(apiFetchJson, TR.DEFAULT_API, TR.DEFAULT_KEY, sid, ym).then(function (r) {
          var n = Object.keys(r.chunk.rows).length;
          if (!n) { lines.push(rocMonth(ym) + '：環境部沒有這個月的資料'); return; }
          got.push(r.chunk);
          lines.push(rocMonth(ym) + '：' + n + ' 小時，測項 ' + Object.keys(r.chunk.items).join('、') + '（無效 ' + r.invalid + ' 筆）');
        }).catch(function (e) { failed.push(rocMonth(ym) + '：' + e.message); });
      });
    }, Promise.resolve()).then(function () { return saveChunks(got); }).then(function (st) {
      $('apiMsg').innerHTML = (got.length ? '<div class="msg ok">' + esc(siteInfo(sid).sitename) + '站抓取完成：新增 ' + st.added + ' 筆、更新 ' + st.replaced + ' 筆。</div>' : '') +
        (lines.length ? '<ul class="issues">' + lines.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        (failed.length ? '<div class="msg err">以下月份沒抓到：<br>' + failed.map(esc).join('<br>') + '<br>請按「測試連線」檢查，或改用自行匯入 CSV 檔。若一直抓不到，可能是環境部網址變更，請找 AI 協助修改。' + AI_HINT + '</div>' : '');
      renderSiteSelect(); renderMoeList(); renderTrendItems(); trDirty();
    }).catch(function (e) { $('apiMsg').innerHTML = '<div class="msg err">' + esc(e.message || e) + '</div>'; }).then(function () { btn.disabled = false; });
  });
  function rawList() {
    var am = apiMonths(); if (am.error) { $('apiMsg').innerHTML = '<div class="msg err">' + esc(am.error) + '</div>'; return null; }
    var list = TR.rawRows(moeChunks(curSite()), am.from, am.to);
    if (!list.length) { $('apiMsg').innerHTML = '<div class="msg err">' + esc(siteInfo(curSite()).sitename) + '站在 ' + rocMonth(am.from) + '～' + rocMonth(am.to) + ' 沒有資料，請先自動抓取或匯入 CSV。</div>'; return null; }
    return { list: list, am: am };
  }
  function rawBase(x) { var pc = (Store.current() && Store.current().code) ? safeName(Store.current().code) + '_' : ''; return pc + '環境部' + safeName(siteInfo(curSite()).sitename) + '站原始數據_' + ymRoc(x.am.from) + (x.am.from === x.am.to ? '' : '-' + ymRoc(x.am.to)); }
  $('rawCsv').addEventListener('click', function () {
    var x = rawList(); if (!x) return;
    download(new Blob([TR.toCsv(x.list)], { type: 'text/csv;charset=utf-8' }), rawBase(x) + '.csv');
    $('apiMsg').innerHTML = '<div class="msg ok">已下載 ' + x.list.length.toLocaleString() + ' 筆原始數據（CSV）。</div>';
  });
  $('rawXlsx').addEventListener('click', function () {
    var x = rawList(); if (!x) return;
    var btn = $('rawXlsx'); btn.disabled = true;
    var info = ['環境部 ' + siteInfo(curSite()).sitename + ' 站原始數據（空氣品質小時值）', '月份：' + rocMonth(x.am.from) + '～' + rocMonth(x.am.to),
      '「逐時表」：每小時一列、每個測項一欄；「原始資料」：與環境部 CSV 相同的欄位，數值原樣保留（x、#、* 等為環境部的無效標記）。', '來源：環境部環境資料開放平臺（自動抓取或匯入的 CSV）', '產生時間：' + new Date().toLocaleString('zh-TW')];
    TR.buildRawWorkbook(ExcelJS, x.list, info).xlsx.writeBuffer().then(function (buf) {
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), rawBase(x) + '_' + stamp() + '.xlsx');
      $('apiMsg').innerHTML = '<div class="msg ok">已下載 ' + x.list.length.toLocaleString() + ' 筆原始數據（Excel）。</div>';
    }).catch(function (e) { $('apiMsg').innerHTML = '<div class="msg err">Excel 產生失敗：' + esc(e.message || e) + '</div>'; }).then(function () { btn.disabled = false; });
  });

  // ---- 趨勢圖 ----
  function trSensorFields() { var f = {}; state.chunks.forEach(function (c) { c.fields.forEach(function (x) { f[x] = true; }); }); return f; }
  function stationItems(sid) { var it = {}; moeChunks(sid).forEach(function (c) { Object.keys(c.items).forEach(function (k) { it[k] = c.items[k]; }); }); return it; }
  function renderTrendItems() {
    var sf = trSensorFields(), si = refItems(), sel = trSet().items || TR.TREND_ITEMS.filter(function (x) { return x.def; }).map(function (x) { return x.key; });
    var list = TR.TREND_ITEMS.filter(function (x) { return sf[x.key] || (x.moe && si[x.moe]); });
    $('trItems').innerHTML = list.length ? list.map(function (x) {
      var note = !sf[x.key] ? '（感測器沒有這個測項）' : !(x.moe && si[x.moe]) ? '（勾選的測站都沒有這個測項）' : '';
      return '<label class="bf"><input type="checkbox" data-tri="' + x.key + '"' + (sel.indexOf(x.key) >= 0 ? ' checked' : '') + '> ' + esc(x.label) + (note ? ' <span class="hint">' + note + '</span>' : '') + '</label>';
    }).join('') : '<span class="hint">尚未匯入資料。</span>';
    var y = trSet().y || {};
    $('trYRange').innerHTML = '<table><tr><th class="l">測項</th><th>Y 最小</th><th>Y 最大</th></tr>' + list.map(function (x) {
      var v = y[x.key] || {};
      return '<tr><td class="l">' + esc(x.label) + '</td><td><input type="number" step="any" class="num" data-try="' + x.key + '|min" value="' + (typeof v.min === 'number' ? v.min : '') + '"></td><td><input type="number" step="any" class="num" data-try="' + x.key + '|max" value="' + (typeof v.max === 'number' ? v.max : '') + '"></td></tr>';
    }).join('') + '</table><p class="hint">Y 軸最大值空白時自動決定：為了看趨勢，不會為少數異常高值拉高，超過的線條在圖頂端截斷。</p>';
    renderTrendSensors();
  }
  // ---- 比對的環境部測站（可多選，最多 5 站；顏色依勾選順序，彼此不重複）----
  var MAX_REFS = 5;
  function sitesWithData() { var s = {}; moeChunks().forEach(function (c) { s[c.siteid] = true; }); return s; }
  function refSites() {
    var have = sitesWithData(), saved = trSet().refSites;
    var list = (Array.isArray(saved) ? saved : [curSite()]).map(String).filter(function (id) { return have[id]; });
    if (!list.length && !Array.isArray(saved) && have[curSite()]) list = [curSite()];
    return list.slice(0, MAX_REFS);
  }
  function refColor(i) { return TR.REF_COLORS[i % TR.REF_COLORS.length]; }
  function refItems() { var it = {}; refSites().forEach(function (sid) { var x = stationItems(sid); Object.keys(x).forEach(function (k) { it[k] = x[k]; }); }); return it; }
  function renderTrendRefs() {
    var have = sitesWithData(), sel = refSites(), ids = Object.keys(have);
    ids.sort(function (a, b) { var ia = sel.indexOf(a), ib = sel.indexOf(b); if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); return collator.compare(siteInfo(a).county + siteInfo(a).sitename, siteInfo(b).county + siteInfo(b).sitename); });
    $('trRefs').innerHTML = ids.length ? ids.map(function (id) {
      var k = sel.indexOf(id), n = moeChunks(id).length;
      return '<label class="bf"><input type="checkbox" data-trref="' + esc(id) + '"' + (k >= 0 ? ' checked' : '') + '> ' +
        (k >= 0 ? '<span style="display:inline-block;width:22px;height:4px;background:' + refColor(k) + ';vertical-align:middle;margin-right:4px"></span>' : '') +
        esc(siteLabel(id)) + ' <span class="hint">（' + esc(siteInfo(id).county || '') + '，' + n + ' 個月）</span></label>';
    }).join('') : '<span class="hint">還沒有任何環境部測站的資料，請先在上方選測站並自動抓取或匯入 CSV。</span>';
  }
  function renderTrendSensors() {
    var ts = trSet(), off = ts.offSensors || [], items = selItems();
    var list = allSensorMeta().filter(function (s) {
      return state.chunks.some(function (c) { return c.id === s.id && items.some(function (k) { return c.fields.indexOf(k) >= 0; }); });
    }).sort(function (a, b) { return collator.compare(a.name, b.name); });
    $('trSensors').innerHTML = list.length ? list.map(function (s) {
      return '<label style="display:block"><input type="checkbox" data-trs="' + esc(s.id) + '"' + (off.indexOf(s.id) < 0 ? ' checked' : '') + '> ' + esc(s.name) + ' <span class="hint">' + esc(s.id) + '</span></label>';
    }).join('') : '<p class="hint">沒有感測器有勾選的測項。</p>';
  }
  function selItems() {
    var els = document.querySelectorAll('[data-tri]');
    if (!els.length) return trSet().items || ['PM25', 'PM10'];
    return Array.prototype.filter.call(els, function (x) { return x.checked; }).map(function (x) { return x.dataset.tri; });
  }
  function renderTrendForm() {
    migrateMoenv().then(function () {
      fillRangeForm('tr', trReady);
      renderSiteSelect(); renderMoeList(); renderApiDefaults(); renderTrendRefs(); renderTrendItems();
      if (!trReady) {
        var ts = trSet();
        if (typeof ts.title === 'boolean') $('trTitle').checked = ts.title;
        if (ts.freq === 'hour') document.querySelector('input[name=trFreq][value=hour]').checked = true;
      }
      trReady = true;
    });
  }
  function trDirty() { if (trResult) { trResult = null; $('trXlsx').disabled = true; $('trPngs').disabled = true; $('trMsg').innerHTML = '<div class="msg info">設定已變更，請重新按「產生趨勢圖」。</div>'; } }
  $('tab-trend').addEventListener('change', function (e) {
    var t = e.target;
    if (['moeFile', 'moeLabel', 'moeDelM', 'moeSite', 'apiFrom', 'apiTo'].indexOf(t.id) >= 0) return;
    if (t.dataset.tri) { trSave({ items: selItems() }); renderTrendSensors(); }
    if (t.dataset.trref) {
      var cur = refSites().filter(function (id) { return id !== t.dataset.trref; });
      if (t.checked) {
        if (cur.length >= MAX_REFS) { t.checked = false; $('trMsg').innerHTML = '<div class="msg warn">最多同時比對 ' + MAX_REFS + ' 個環境部測站（顏色才不會重複、圖才看得清楚）。請先取消其他測站。</div>'; return; }
        cur.push(t.dataset.trref);
      }
      trSave({ refSites: cur }); renderTrendRefs(); renderTrendItems();
    }
    if (t.dataset.trs) trSave({ offSensors: Array.prototype.map.call(document.querySelectorAll('[data-trs]:not(:checked)'), function (x) { return x.dataset.trs; }) });
    if (t.dataset.try) {
      var y = {}; document.querySelectorAll('[data-try]').forEach(function (x) { var p = x.dataset.try.split('|'), n = Number(x.value); if (x.value !== '' && isFinite(n)) (y[p[0]] = y[p[0]] || {})[p[1]] = n; });
      trSave({ y: y });
    }
    if (t.id === 'trTitle' || t.name === 'trFreq') trSave({ title: $('trTitle').checked, freq: document.querySelector('input[name=trFreq]:checked').value });
    trDirty();
  });
  $('trAll').addEventListener('click', function () { document.querySelectorAll('[data-trs]').forEach(function (x) { x.checked = true; }); trSave({ offSensors: [] }); trDirty(); });
  $('trNone').addEventListener('click', function () { document.querySelectorAll('[data-trs]').forEach(function (x) { x.checked = false; }); trSave({ offSensors: Array.prototype.map.call(document.querySelectorAll('[data-trs]'), function (x) { return x.dataset.trs; }) }); trDirty(); });
  function trBuild(r) {
    var hourly = document.querySelector('input[name=trFreq]:checked').value === 'hour';
    var on = {}; document.querySelectorAll('[data-trs]:checked').forEach(function (x) { on[x.dataset.trs] = true; });
    var zero = $('optPmZero').checked ? Core.ZERO_INVALID : [], ratio = $('optPmRatio').checked;
    var keys = selItems(), items = TR.TREND_ITEMS.filter(function (x) { return keys.indexOf(x.key) >= 0; });
    var sensors = proc().sensors.filter(function (s) { return on[s.id] && items.some(function (x) { return s.fields.indexOf(x.key) >= 0; }); })
      .sort(function (a, b) { return collator.compare(sensorName(a.id), sensorName(b.id)); });
    var days = Core.daysBetween(r.from, r.to), x = [];
    if (hourly) days.forEach(function (d) { for (var h = 0; h < 24; h++) x.push(d + ' ' + Core.pad(h) + ':00'); }); else x = days.slice();
    var idx = {}; x.forEach(function (t, i) { idx[t] = i; });
    var refs = refSites().map(function (sid, i) { return { sid: sid, chunks: moeChunks(sid), si: stationItems(sid), label: siteLabel(sid), color: refColor(i) }; });
    var pn = plotNames(sensors.map(function (s) { return s.id; }));
    var reportKeys = Core.AIR_FIELDS;
    var daily = hourly ? null : Core.buildReports(sensors, r, { fillMissingDays: false, zeroInvalid: zero, pmRatioInvalid: ratio, noise: settings().noise }).air;
    var ys = trSet().y || {};
    return { hourly: hourly, charts: items.map(function (it) {
      var series = [], k = 0, noData = [];
      sensors.forEach(function (s) {
        if (s.fields.indexOf(it.key) < 0) return;
        var vals = x.map(function () { return null; }), any = false;
        if (hourly || reportKeys.indexOf(it.key) < 0) {
          // 逐時，或報表沒有的測項（氣體類）：由逐時有效值自己算日平均
          var hrs = {};
          s.rows.forEach(function (row) { if (row.ts.slice(0, 10) < r.from || row.ts.slice(0, 10) > r.to) return; if (M.counted(row, it.key, zero, ratio)) hrs[row.ts] = row.v[it.key]; });
          var src = hourly ? hrs : TR.dailyOf(hrs, it.sum);
          Object.keys(src).forEach(function (t) { var i = idx[t]; if (i !== undefined && src[t] !== null) { vals[i] = src[t]; any = true; } });
        } else daily.forEach(function (d) { if (d.id !== s.id) return; var i = idx[d.date]; if (i !== undefined && typeof d[it.key] === 'number') { vals[i] = d[it.key]; any = true; } });
        if (!any) { noData.push(pn[s.id]); return; }
        series.push({ name: pn[s.id], color: TR.PALETTE[k++ % TR.PALETTE.length], values: vals });
      });
      // 每個比對測站一條粗線（顏色依勾選順序）；refStat 記錄每站的狀況給畫面提示
      var refStat = [], unit = it.unit;
      refs.forEach(function (rf) {
        var st = { label: rf.label, color: rf.color, has: !!(it.moe && rf.si[it.moe]), any: false, missing: 0 };
        if (st.has) {
          if (rf.si[it.moe].itemunit && unit === it.unit) unit = TR.unitText(rf.si[it.moe].itemunit);
          var mh = TR.stationHours(rf.chunks, it.moe, r.from, r.to), ms = hourly ? mh : TR.dailyOf(mh, it.sum);
          var ref = x.map(function (t) { var v = ms[t]; return v === undefined ? null : v; });
          st.any = ref.some(function (v) { return v !== null; });
          st.missing = ref.filter(function (v) { return v === null; }).length;
          if (st.any) series.push({ name: rf.label, color: rf.color, ref: true, values: ref });
        }
        refStat.push(st);
      });
      var refAny = refStat.some(function (x) { return x.any; });
      var y = ys[it.key] || {}, auto = TR.autoYMax(series);
      return { key: it.key, sheet: it.label.replace(/[₀-₉]/g, function (c) { return String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c)); }), title: it.label, yTitle: it.label + '（' + unit + '）', xTitle: hourly ? '日期時間' : '日期', yMin: y.min,
        yMax: typeof y.max === 'number' ? y.max : auto.max, autoCut: typeof y.max === 'number' ? 0 : auto.cut, showTitle: $('trTitle').checked, hourly: hourly, x: x, series: series, noData: noData,
        refAny: refAny, refStat: refStat };
    }) };
  }
  $('trGo').addEventListener('click', function () {
    var r = bxRange('tr');
    if (r.error) { $('trMsg').innerHTML = '<div class="msg err">' + esc(r.error) + '</div>'; return; }
    if (!selItems().length) { $('trMsg').innerHTML = '<div class="msg err">請至少勾選一個測項。</div>'; return; }
    $('trMsg').innerHTML = '<div class="msg info">計算中…</div>';
    paint().then(function () {
      var b = trBuild(r), charts = b.charts.filter(function (c) { return c.series.length; }), skipped = b.charts.filter(function (c) { return !c.series.length; }).map(function (c) { return c.title; });
      if (!charts.length) { $('trOut').innerHTML = ''; $('trMsg').innerHTML = '<div class="msg err">這個期間、勾選的測項沒有任何資料。</div>'; return; }
      trResult = { range: r, hourly: b.hourly, charts: charts, refs: refSites() };
      var unit = b.hourly ? '小時' : '天', lab = refSites().map(siteLabel).join('、') || '（未勾選環境部測站）';
      $('trOut').innerHTML = charts.map(function (c, i) {
        return '<div class="card bxfig"><h3>' + esc(c.title) + ' <span class="hint">（' + c.series.filter(function (s) { return !s.ref; }).length + ' 台感測器' + (c.refAny ? '＋環境部 ' + c.series.filter(function (s) { return s.ref; }).length + ' 站' : '') + '；Y 軸上限 ' + c.yMax + '）</span></h3><canvas data-trc="' + i + '"></canvas>' +
          '<div class="row"><button type="button" data-trpng="' + i + '">下載這張圖（PNG）</button>' + (c.autoCut ? '<span class="hint">有 ' + c.autoCut + ' 個異常高值超過 Y 軸上限，線條在圖頂端截斷（主要看趨勢；要看全部請在上方填 Y 軸最大值）。</span>' : '') +
          (c.noData.length ? '<span class="hint">期間內沒有有效數值、未畫：' + esc(c.noData.join('、')) + '</span>' : '') +
          c.refStat.map(function (st) {
            return !st.has ? '<span class="hint">' + esc(st.label) + '沒有這個測項（或還沒抓取），圖上沒有這站的線。</span>' : !st.any ? '<span class="hint">這個期間沒有' + esc(st.label) + '的資料，圖上沒有這站的線。</span>' : st.missing ? '<span class="hint">有 ' + st.missing + ' ' + unit + '沒有' + esc(st.label) + '資料，這站的線在這些地方會斷開。</span>' : '';
          }).join('') + '</div></div>';
      }).join('');
      charts.forEach(function (c, i) { TR.drawTrend(document.querySelector('canvas[data-trc="' + i + '"]'), c, 1.5); });
      $('trXlsx').disabled = false; $('trPngs').disabled = false;
      $('trMsg').innerHTML = '<div class="msg ok">期間 <b>' + esc(r.title) + '</b>（' + Core.toRoc(r.from) + '～' + Core.toRoc(r.to) + '），' + (b.hourly ? '逐時' : '日平均') + '，比對測站：' + esc(lab) + '：已產生 ' + charts.length + ' 張趨勢圖。' +
        (skipped.length ? '沒有資料、未畫：' + esc(skipped.join('、')) + '。' : '') + '</div>' + (!refSites().length ? '<div class="msg warn">沒有勾選比對的環境部測站，圖上只有感測器。</div>' : charts.every(function (c) { return !c.refAny; }) ? '<div class="msg warn">這個期間沒有' + esc(lab) + '的資料，圖上沒有環境部的線。請先在上方自動抓取或匯入 CSV。</div>' : '');
    });
  });
  function trFileBase() {
    var pc = (Store.current() && Store.current().code) ? safeName(Store.current().code) + '_' : '', rs = trResult.refs || [];
    var st = rs.length ? (rs.length <= 3 ? rs.map(function (id) { return safeName(siteInfo(id).sitename); }).join('_') + '站' : safeName(siteInfo(rs[0]).sitename) + '等' + rs.length + '站') : '無測站';
    return pc + '環境部比對趨勢圖_' + st + '_' + trResult.range.label + (trResult.hourly ? '_逐時' : '_日平均'); }
  function trPngBlob(c) { return new Promise(function (res) { var cv = document.createElement('canvas'); TR.drawTrend(cv, c, 3); cv.toBlob(function (b) { res(b); }, 'image/png'); }); }
  $('trOut').addEventListener('click', function (e) {
    var i = e.target.dataset.trpng; if (i === undefined || !trResult) return;
    var c = trResult.charts[+i];
    trPngBlob(c).then(function (b) { download(b, trFileBase() + '_' + safeName(c.sheet) + '.png'); });
  });
  $('trPngs').addEventListener('click', function () {
    if (!trResult) return;
    var zip = new window.JSZip(), btn = $('trPngs'), old = btn.textContent; btn.disabled = true; btn.textContent = '產生中…';
    trResult.charts.reduce(function (p, c, i) { return p.then(function () { return trPngBlob(c).then(function (b) { zip.file((i + 1) + '_' + safeName(c.sheet) + '.png', b); }); }); }, Promise.resolve())
      .then(function () { return zip.generateAsync({ type: 'blob' }); })
      .then(function (b) { download(b, trFileBase() + '_圖片.zip'); })
      .catch(function (er) { $('trMsg').innerHTML = '<div class="msg err">圖片產生失敗：' + esc(er.message || er) + '</div>'; })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  });
  $('trXlsx').addEventListener('click', function () {
    if (!trResult) return;
    var btn = $('trXlsx'), old = btn.textContent; btn.disabled = true; btn.textContent = '產生中…';
    var r = trResult.range, cur = Store.current() || {}, lab = (trResult.refs || []).map(function (id, i) { return siteLabel(id) + '（' + ['紅', '橘', '黑', '桃紅', '紫'][i] + '色）'; }).join('、') || '（未勾選）';
    var info = ['環境部測站比對趨勢圖（' + (cur.code ? cur.code + ' ' : '') + (cur.name || '') + '）',
      '期間：' + r.title + '（' + Core.toRoc(r.from) + '～' + Core.toRoc(r.to) + '），' + (trResult.hourly ? '逐時值' : '日平均') + '；比對測站：' + lab,
      '感測器：數值和報表相同（異常值、空白、PM 為 0、PM2.5 大於 PM10、備註時段／疑似異常／手動設為不採用的小時都不列入）' + (trResult.hourly ? '。' : '；日平均為當日有效小時的平均（雨量為加總），四捨五入到小數 1 位。'),
      '環境部測站：環境部空氣品質小時值，x、#、* 等無效值不計' + (trResult.hourly ? '。' : '；日平均為當日有效小時的平均（雨量為加總），四捨五入到小數 1 位。'),
      '「趨勢圖」工作表：Excel 折線圖，環境部測站為粗線（顏色如上）；圖的資料在各測項工作表，修改數值圖會跟著更新。空白格＝沒有有效數值，折線會斷開。',
      'Y 軸上限：' + trResult.charts.map(function (c) { return c.title + ' ' + c.yMax; }).join('、') + '（為了看趨勢，少數異常高值會超出圖頂端；要看全部請在圖上按右鍵「座標軸格式」把最大值改成自動）。',
      '產生時間：' + new Date().toLocaleString('zh-TW')];
    TR.buildTrendWorkbook(ExcelJS, window.JSZip, trResult.charts, info, trResult.hourly).then(function (buf) {
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), trFileBase() + '_' + stamp() + '.xlsx');
    }).catch(function (er) { $('trMsg').innerHTML = '<div class="msg err">Excel 產生失敗：' + esc(er.message || er) + '</div>'; })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  });
})();
