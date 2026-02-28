const DB_NAME = 'bookmark-rag-db';
const DB_VERSION = 1;
const DOC_STORE = 'documents';
const META_STORE = 'meta';

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function clearDocuments() {
  const db = await openDB();
  const tx = db.transaction([DOC_STORE], 'readwrite');
  tx.objectStore(DOC_STORE).clear();
  await txComplete(tx);
}

export async function putDocuments(documents) {
  if (!documents.length) return;
  const db = await openDB();
  const tx = db.transaction([DOC_STORE], 'readwrite');
  const store = tx.objectStore(DOC_STORE);

  for (const doc of documents) {
    store.put(doc);
  }

  await txComplete(tx);
}

export async function getAllDocuments() {
  const db = await openDB();
  const tx = db.transaction([DOC_STORE], 'readonly');
  const request = tx.objectStore(DOC_STORE).getAll();

  const docs = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });

  await txComplete(tx);
  return docs;
}

export async function deleteDocument(id) {
  const db = await openDB();
  const tx = db.transaction([DOC_STORE], 'readwrite');
  tx.objectStore(DOC_STORE).delete(id);
  await txComplete(tx);
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction([META_STORE], 'readwrite');
  tx.objectStore(META_STORE).put({ key, value });
  await txComplete(tx);
}

export async function getMeta(key) {
  const db = await openDB();
  const tx = db.transaction([META_STORE], 'readonly');
  const request = tx.objectStore(META_STORE).get(key);

  const result = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });

  await txComplete(tx);
  return result;
}
