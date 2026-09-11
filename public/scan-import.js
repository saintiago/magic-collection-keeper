import { createScanner } from "./scanner.js";
import { reviewCache } from "./review-cache.js";
import { snapshotKey } from "./collection-cache.js";
import { collectionIdentity, config } from "./auth.js";
import { createScanRecognition } from "./scan-recognition.js";
import { createScanSession, captureBatch } from "./scan-session.js";

export async function setupScanImport({ api, enter, notify }) {
  const account = snapshotKey(await collectionIdentity());
  let loadError = "",
    busy = false,
    disposed = false;
  const saved = await reviewCache.read(account).catch(() => {
    loadError = "Saved captures could not be loaded. Reload before scanning.";
    return null;
  });
  let legacy = saved && saved.schema !== 2 ? saved : null;
  if (
    legacy &&
    (!Array.isArray(legacy.rows) ||
      legacy.rows.length > 50 ||
      legacy.rows.some((row) => !row || !Array.isArray(row.candidates)))
  )
    loadError =
      "Saved captures are invalid. Reload before starting another scan.";
  const storage = {
    journal: (value) => reviewCache.journal(account, value),
    write: (value) => reviewCache.write(account, value),
  };
  let session;
  try {
    session = createScanSession({
      storage,
      saved: saved?.schema === 2 ? saved : undefined,
      initialRevision: saved?.revision || 0,
      stage: async (payload) => {
        if (disposed) throw new DOMException("Signed out", "AbortError");
        return api("/api/scan-session/batch", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      },
    });
  } catch (error) {
    loadError = error.message;
  }
  const resume = document.createElement("button");
  resume.id = "resume-review";
  resume.className = "secondary";
  resume.textContent = "Review saved scan";
  document.getElementById("scan").after(resume);
  function update() {
    const current = session?.current();
    resume.hidden =
      disposed ||
      !(legacy?.rows.length || current?.rows.length || current?.lastBatch);
    resume.disabled = busy;
  }
  async function migrateLegacy() {
    if (legacy.submitted) {
      const result = await api("/api/collection/batch", {
        method: "POST",
        body: JSON.stringify(legacy.submitted),
      });
      const committed = new Set(result.saved);
      legacy = {
        ...legacy,
        id: crypto.randomUUID(),
        submitted: null,
        rows: legacy.rows.filter(
          (row) => !row.saved && !committed.has(row.operationId),
        ),
        revision: (legacy.revision || 0) + 1,
      };
      storage.journal(legacy);
      await storage.write(legacy);
    }
    for (const row of legacy.rows) row.captureId ||= crypto.randomUUID();
    storage.journal(legacy);
    await storage.write(legacy);
    let selected;
    if (legacy.rows.length) {
      const result = await api("/api/import-draft/stage", {
        method: "POST",
        body: JSON.stringify(captureBatch(legacy.id, legacy.rows)),
      });
      if (result.staged_id !== legacy.id)
        throw Error("Could not confirm recovered captures.");
      selected = result.draft?.id;
    }
    await session.checkpoint([], {});
    legacy = null;
    if (!disposed) enter(selected);
  }
  async function review(rows, metadata) {
    if (loadError) return notify(loadError);
    if (busy || disposed) return;
    busy = true;
    update();
    try {
      if (legacy) await migrateLegacy();
      else {
        const current = session.current();
        const result = await session.seal(
          rows || current.rows,
          metadata || current,
        );
        if (!disposed) enter(result.lastBatch || undefined);
      }
    } catch (error) {
      if (!disposed)
        notify(
          `${error.message} Captures remain here. Retry Review saved scan.`,
        );
    } finally {
      busy = false;
      update();
    }
  }
  const scanner = createScanner({
    api,
    recognition: createScanRecognition(api, {
      cloudEnabled: config.backendRecognition === true,
    }),
    onRows: async (rows, metadata) => {
      if (disposed) return;
      await session.checkpoint(rows, metadata);
      update();
    },
    onBatch: async (rows, metadata) => {
      const result = await session.seal(rows, metadata);
      if (disposed) throw new DOMException("Signed out", "AbortError");
      update();
      return result;
    },
    onReview: review,
  });
  document.getElementById("scan").onclick = async () => {
    if (busy || disposed) return;
    if (loadError) return notify(loadError);
    if (legacy) return review();
    busy = true;
    update();
    try {
      let current = session.current();
      if (current.outgoing) current = await session.seal(current.rows, current);
      if (!disposed) scanner.open(current);
    } catch (error) {
      if (!disposed)
        notify(`${error.message} Retry to recover the saved batch.`);
    } finally {
      busy = false;
      update();
    }
  };
  document.getElementById("scan").disabled = false;
  document.getElementById("scan").removeAttribute("aria-busy");
  resume.onclick = () => review();
  window.addEventListener("keeper-sign-out", () => {
    disposed = true;
    update();
  });
  if (location.hash.startsWith("#review=")) {
    history.replaceState(null, "", "#import");
    if (legacy?.rows.length || session?.current().rows.length) void review();
    else enter();
  }
  update();
}
