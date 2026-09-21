function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('park-area-data', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('datasets', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storedDatasets() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('datasets').objectStore('datasets').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function saveDataset(dataset) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('datasets', 'readwrite');
      tx.objectStore('datasets').put(dataset);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存が中断されました。'));
    });
  } finally { db.close(); }
}

export async function deleteDataset(id) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('datasets', 'readwrite');
      tx.objectStore('datasets').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('削除が中断されました。'));
    });
  } finally { db.close(); }
}
