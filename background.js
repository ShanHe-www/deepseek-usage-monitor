/**
 * background.js — MV3 Service Worker
 * 职责：
 *  - 管理本地 IndexedDB（明细存储 + 元信息）
 *  - 响应 popup 的查询 / 同步 / 导出请求
 *  - 明细按 (月份, utc_date, model, api_key_name, type) 去重；type 聚合为
 *    input/output/requests 三类存储，避免重复抓取同一月份时数据翻倍。
 */

'use strict';

const DB_NAME = 'DeepSeekUsageDB';
const DB_VERSION = 2;
const STORE = 'usage_records';   // keyPath: id
const META = 'meta';             // keyPath: key

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('month', 'month', { unique: false });
        store.createIndex('utc_date', 'utc_date', { unique: false });
        store.createIndex('model', 'model', { unique: false });
        store.createIndex('api_key_name', 'api_key_name', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function txStore(mode, name = STORE) {
  return openDB().then((db) => {
    const tx = db.transaction(name, mode);
    return { db, tx, store: tx.objectStore(name) };
  });
}

// ---- 明细写入（去重）------------------------------------------------------
async function saveRecords(records) {
  const { db, tx, store } = await txStore('readwrite');
  let added = 0, updated = 0;
  for (const r of records) {
    if (!r.id) continue;
    const existing = await new Promise((res, rej) => {
      const g = store.get(r.id);
      g.onsuccess = () => res(g.result);
      g.onerror = () => rej(g.error);
    });
    if (existing) {
      store.put(r);
      updated++;
    } else {
      store.put(r);
      added++;
    }
  }
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
  return { added, updated };
}

// ---- 查询 ----------------------------------------------------------------
async function queryRecords({ month, model, apiKey } = {}) {
  const { db, tx, store } = await txStore('readonly');
  let rows;
  if (month) {
    const idx = store.index('month');
    rows = await new Promise((res, rej) => {
      const g = idx.getAll(month);
      g.onsuccess = () => res(g.result || []);
      g.onerror = () => rej(g.error);
    });
  } else {
    rows = await new Promise((res, rej) => {
      const g = store.getAll();
      g.onsuccess = () => res(g.result || []);
      g.onerror = () => rej(g.error);
    });
  }
  if (model) rows = rows.filter((r) => r.model === model);
  if (apiKey) rows = rows.filter((r) => r.api_key_name === apiKey);
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
  return rows;
}

// ---- 元信息 --------------------------------------------------------------
async function getMeta(key, def) {
  const { db, tx, store } = await txStore('readonly', META);
  const v = await new Promise((res, rej) => {
    const g = store.get(key);
    g.onsuccess = () => res(g.result);
    g.onerror = () => rej(g.error);
  });
  tx.oncomplete = () => db.close();
  return v ? v.value : def;
}

async function setMeta(key, value) {
  const { db, tx, store } = await txStore('readwrite', META);
  store.put({ key, value });
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

// ---- 清除 ----------------------------------------------------------------
async function clearAll() {
  const { db, tx, store } = await txStore('readwrite');
  store.clear();
  const mtx = db.transaction(META, 'readwrite');
  mtx.objectStore(META).clear();
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  await new Promise((res, rej) => {
    mtx.oncomplete = res;
    mtx.onerror = () => rej(mtx.error);
  });
  db.close();
}

// ---- 消息路由 ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.action) {
        case 'saveRecords': {
          const res = await saveRecords(msg.records || []);
          sendResponse({ ok: true, ...res });
          break;
        }
        case 'queryRecords': {
          const rows = await queryRecords(msg || {});
          sendResponse({ ok: true, records: rows });
          break;
        }
        case 'getMeta': {
          sendResponse({ ok: true, value: await getMeta(msg.key, msg.def) });
          break;
        }
        case 'setMeta': {
          await setMeta(msg.key, msg.value);
          sendResponse({ ok: true });
          break;
        }
        case 'clearAll': {
          await clearAll();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true; // 异步响应，保持消息通道打开
});
