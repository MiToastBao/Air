/*
 * 瀏覽器內儲存（IndexedDB）。資料只存在這台電腦的這個瀏覽器，不會上傳到 GitHub。
 *  chunks : key = 感測器編號|YYYY-MM → {key, id, month, fields:[...], rows:[{ts, v, note?}]}
 *  sensors: key = 感測器編號 → {id, label, name}
 *  meta   : key = 'settings' 等
 */
(function (root) {
  'use strict';
  var DB_NAME = 'env-quarterly-report';
  var DB_VER = 1;
  var db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('此瀏覽器不支援 IndexedDB，無法保存匯入的資料。')); return; }
      var req = root.indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('sensors')) d.createObjectStore('sensors', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error || new Error('無法開啟瀏覽器資料庫')); };
      req.onblocked = function () { reject(new Error('資料庫被其他分頁占用，請關閉本網站的其他分頁後重新整理。')); };
    });
  }

  function all(store) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, 'readonly');
      var req = tx.objectStore(store).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** 一次交易寫入；任何一筆失敗整批不寫入 */
  function writeBatch(ops) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['chunks', 'sensors', 'meta'], 'readwrite');
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

  function loadAll() {
    return Promise.all([all('chunks'), all('sensors'), all('meta')]).then(function (r) {
      return { chunks: r[0], sensors: r[1], meta: r[2] };
    });
  }

  var api = { open: open, loadAll: loadAll, writeBatch: writeBatch, DB_NAME: DB_NAME };
  root.EnvStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
