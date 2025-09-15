// src/storage.js
const DB_NAME = 'roastpred-db';
const STORE = 'sessions';

function withDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject('no-idb');
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(obj) {
  const db = await withDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGetAll() {
  const db = await withDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function idbDelete(id) {
  const db = await withDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// fallback to localStorage
const LS_KEY = 'roastpred-sessions';
function lsAll() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}
function lsWrite(all) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export async function saveSession(session) {
  const now = new Date().toISOString();
  const rec = {
    ...session,
    id: session.id || crypto?.randomUUID?.() || String(Date.now()),
    updatedAt: now,
  };
  try {
    await idbPut(rec);
    return rec.id;
  } catch {
    const all = lsAll();
    const i = all.findIndex((x) => x.id === rec.id);
    if (i >= 0) all[i] = rec;
    else all.push(rec);
    lsWrite(all);
    return rec.id;
  }
}
export async function listSessions() {
  try {
    const all = await idbGetAll();
    return all.sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
  } catch {
    return lsAll().sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
  }
}
export async function deleteSession(id) {
  try {
    await idbDelete(id);
  } catch {
    const all = lsAll().filter((x) => x.id !== id);
    lsWrite(all);
  }
}
