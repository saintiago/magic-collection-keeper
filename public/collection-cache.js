// Display snapshots only. Authentication stays in auth.js; inventory stays on the server.
const DATABASE = "keeper-display-v1";
function open() {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("Display cache unavailable"));
    }, 1500);
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("snapshots");
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}
async function transaction(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode);
      const request = action(tx.objectStore("snapshots"));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export function snapshotKey({ environment, owner }) {
  if (!environment || !owner)
    throw new Error("Verified account required for display cache.");
  return JSON.stringify([1, environment, owner]);
}
export const snapshotStore = {
  read: (key) => transaction("readonly", (store) => store.get(key)),
  write: (key, value) =>
    transaction("readwrite", (store) => store.put(value, key)),
  remove: (key) => transaction("readwrite", (store) => store.delete(key)),
};
export async function clearSnapshotCaches() {
  try {
    await transaction("readwrite", (store) => store.clear());
  } catch {
    /* Cache is optional. */
  }
}
