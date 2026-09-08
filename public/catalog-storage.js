// Public names only. Never store a session or inventory in this database.
export function catalogStorage() {
  async function transact(mode, action) {
    let db;
    try {
      db = await new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          reject(Error("Catalog storage timed out"));
        }, 1500);
        const r = indexedDB.open("keeper-public-catalog-v1", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("catalog");
        r.onsuccess = () => {
          clearTimeout(timer);
          if (expired) r.result.close();
          else resolve(r.result);
        };
        r.onerror = () => {
          clearTimeout(timer);
          reject(r.error);
        };
      });
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("catalog", mode),
          r = action(tx.objectStore("catalog"));
        const timer = setTimeout(() => {
          tx.abort();
          reject(Error("Catalog storage timed out"));
        }, 3000);
        tx.oncomplete = () => {
          clearTimeout(timer);
          resolve(r.result);
        };
        tx.onerror = tx.onabort = () => {
          clearTimeout(timer);
          reject(tx.error);
        };
      });
    } finally {
      db?.close();
    }
  }
  return {
    read: () => transact("readonly", (s) => s.get("current")),
    write: (v) => transact("readwrite", (s) => s.put(v, "current")),
  };
}
