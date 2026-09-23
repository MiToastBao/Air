/*
 * 瀏覽器內儲存（IndexedDB）。資料只存在這台電腦的這個瀏覽器，不會上傳到 GitHub。
 *
 * 每個「計畫」各用一個獨立的資料庫，計畫之間的資料完全不互相影響：
 *  chunks : key = 感測器編號|YYYY-MM → {key, id, month, fields:[...], rows:[{ts, v, note?}]}
 *  sensors: key = 感測器編號 → {id, label, name, reportId?}
 *  meta   : key = 'settings'、'review'、'manual'、'suspect' 等
 *
 * 計畫清單另存在 env-quarterly-registry：projects {uid, code, name, dbName, createdAt}、meta {key:'current'}
 * 舊版（v1.3.0 以前）的資料在資料庫 env-quarterly-report，第一次開啟時自動登記成一個計畫，資料不搬動。
 */
(function (root) {
  'use strict';
  var LEGACY_DB = 'env-quarterly-report';
  var REG_DB = 'env-quarterly-registry';
  var DB_VER = 1;
  var db = null, reg = null, current = null;

  function openDb(name, upgrade) {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('此瀏覽器不支援 IndexedDB，無法保存匯入的資料。')); return; }
      var req = root.indexedDB.open(name, DB_VER);
      req.onupgradeneeded = function () { upgrade(req.result); };
      req.onsuccess = function () {
        var d = req.result;
        d.onversionchange = function () { d.close(); };
        resolve(d);
      };
      req.onerror = function () { reject(req.error || new Error('無法開啟瀏覽器資料庫')); };
      req.onblocked = function () { reject(new Error('資料庫被其他分頁占用，請關閉本網站的其他分頁後重新整理。')); };
    });
  }
  function dataUpgrade(d) {
    if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'key' });
    if (!d.objectStoreNames.contains('sensors')) d.createObjectStore('sensors', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
  }
  function regUpgrade(d) {
    if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'uid' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
  }
  function getAll(d, store) {
    return new Promise(function (resolve, reject) {
      var req = d.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function batch(d, stores, ops) {
    return new Promise(function (resolve, reject) {
      var tx = d.transaction(stores, 'readwrite');
      ops.forEach(function (op) {
        var st = tx.objectStore(op.store);
        if (op.type === 'put') st.put(op.value);
        else if (op.type === 'delete') st.delete(op.key);
        else if (op.type === 'clear') st.clear();
      });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('寫入失敗')); };
      tx.onabort = function () { reject(tx.error || new Error('寫入被中止（可能是瀏覽器儲存空間不足）')); };
    });
  }
  function deleteDb(name) {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.deleteDatabase(name);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error || new Error('刪除失敗')); };
      req.onblocked = function () { reject(new Error('資料庫被其他分頁占用，請關閉本網站的其他分頁後再試一次。')); };
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /** 開啟計畫清單；第一次使用時把舊版資料登記成一個計畫 */
  function openRegistry() {
    return openDb(REG_DB, regUpgrade).then(function (d) {
      reg = d;
      return getAll(reg, 'projects');
    }).then(function (list) {
      if (list.length) return list;
      var p = { uid: 'legacy', code: '', name: '未命名計畫', dbName: LEGACY_DB, createdAt: new Date().toISOString() };
      return batch(reg, ['projects', 'meta'], [
        { store: 'projects', type: 'put', value: p },
        { store: 'meta', type: 'put', value: { key: 'current', value: p.uid } }
      ]).then(function () { return [p]; });
    });
  }
  function listProjects() {
    return getAll(reg, 'projects').then(function (list) {
      return list.sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1; });
    });
  }
  function currentUid() {
    return getAll(reg, 'meta').then(function (m) {
      var c = m.filter(function (x) { return x.key === 'current'; })[0];
      return c ? c.value : null;
    });
  }
  /** 開啟（切換到）某個計畫 */
  function openProject(p) {
    if (db) { db.close(); db = null; }
    return openDb(p.dbName, dataUpgrade).then(function (d) {
      db = d; current = p;
      return batch(reg, ['meta'], [{ store: 'meta', type: 'put', value: { key: 'current', value: p.uid } }]);
    }).then(function () { return p; });
  }
  function open() {
    return openRegistry().then(function (list) {
      return currentUid().then(function (cu) {
        var p = list.filter(function (x) { return x.uid === cu; })[0] || list[0];
        return openProject(p);
      });
    });
  }
  function createProject(code, name) {
    var id = uid();
    var p = { uid: id, code: code, name: name, dbName: LEGACY_DB + '::' + id, createdAt: new Date().toISOString() };
    return batch(reg, ['projects'], [{ store: 'projects', type: 'put', value: p }]).then(function () { return p; });
  }
  function updateProject(p) { return batch(reg, ['projects'], [{ store: 'projects', type: 'put', value: p }]); }
  /** 刪除計畫（連同它的全部資料） */
  function removeProject(p) {
    var wasCurrent = current && current.uid === p.uid;
    if (wasCurrent && db) { db.close(); db = null; current = null; }
    return deleteDb(p.dbName).then(function () {
      return batch(reg, ['projects'], [{ store: 'projects', type: 'delete', key: p.uid }]);
    });
  }
  /** 清除全部計畫與資料，回到剛開始使用的狀態 */
  function removeAll() {
    return listProjects().then(function (list) {
      if (db) { db.close(); db = null; current = null; }
      return list.reduce(function (pr, p) { return pr.then(function () { return deleteDb(p.dbName); }); }, Promise.resolve());
    }).then(function () {
      return batch(reg, ['projects', 'meta'], [{ store: 'projects', type: 'clear' }, { store: 'meta', type: 'clear' }]);
    });
  }

  function loadAll() {
    return Promise.all([getAll(db, 'chunks'), getAll(db, 'sensors'), getAll(db, 'meta')]).then(function (r) {
      return { chunks: r[0], sensors: r[1], meta: r[2] };
    });
  }
  function writeBatch(ops) { return batch(db, ['chunks', 'sensors', 'meta'], ops); }
  function clearProjectData() {
    return writeBatch([{ store: 'chunks', type: 'clear' }, { store: 'sensors', type: 'clear' }, { store: 'meta', type: 'clear' }]);
  }

  /** 儲存空間：已使用／可用上限（位元組）；瀏覽器不支援時回傳 null */
  function estimate() {
    if (!root.navigator || !navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }
  function persisted() {
    if (!root.navigator || !navigator.storage || !navigator.storage.persisted) return Promise.resolve(null);
    return navigator.storage.persisted().catch(function () { return null; });
  }
  function persist() {
    if (!root.navigator || !navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
    return navigator.storage.persist().catch(function () { return null; });
  }

  var api = {
    open: open, loadAll: loadAll, writeBatch: writeBatch, clearProjectData: clearProjectData,
    listProjects: listProjects, openProject: openProject, createProject: createProject, updateProject: updateProject,
    removeProject: removeProject, removeAll: removeAll, current: function () { return current; },
    estimate: estimate, persisted: persisted, persist: persist, LEGACY_DB: LEGACY_DB
  };
  root.EnvStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
