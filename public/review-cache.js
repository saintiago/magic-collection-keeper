// Durable pending reviews are separate from disposable collection snapshots.
function open() {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Review storage unavailable. Reload and retry."));
    }, 1500);
    const request = indexedDB.open("keeper-review-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("reviews");
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
    request.onblocked = () => {
      expired = true;
      clearTimeout(timer);
      reject(
        new Error("Review storage is blocked. Close older app tabs and retry."),
      );
    };
  });
}
async function use(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("reviews", mode),
        request = action(tx.objectStore("reviews"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const reviewCache = {
  read: async (key) => {
    let journal, stored;
    try {
      journal = JSON.parse(
        localStorage.getItem("keeper-review-journal:" + key),
      );
    } catch {
      /* IndexedDB can recover a blocked/corrupt journal. */
    }
    try {
      stored = await use("readonly", (s) => s.get(key));
    } catch (error) {
      if (!journal) throw error;
    }
    return (journal?.revision || 0) >= (stored?.revision || 0)
      ? journal || stored
      : stored;
  },
  journal: (key, value) =>
    localStorage.setItem("keeper-review-journal:" + key, JSON.stringify(value)),
  write: (key, value) => use("readwrite", (s) => s.put(value, key)),
};
