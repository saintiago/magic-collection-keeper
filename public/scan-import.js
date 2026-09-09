import { createScanner } from "./scanner.js";
import { reviewCache } from "./review-cache.js";
import { snapshotKey } from "./collection-cache.js";
import { collectionIdentity, config } from "./auth.js";
import { createScanRecognition } from "./scan-recognition.js";

// This journal only bridges capture/network interruption. Review lives in Import.
export async function setupScanImport({ api, enter, notify }) {
  const account = snapshotKey(await collectionIdentity());
  let loadError = "";
  let saved = await reviewCache.read(account).catch(() => {
    loadError =
      "Captured cards could not be loaded. Reload before starting another scan.";
    return null;
  });
  if (
    saved &&
    (!Array.isArray(saved.rows) ||
      saved.rows.length > 50 ||
      saved.rows.some((row) => !row || !Array.isArray(row.candidates)))
  )
    loadError =
      "Saved captures are invalid. Reload before starting another scan.";
  let rows = loadError ? [] : saved?.rows || [],
    id = saved?.id || null,
    revision = saved?.revision || 0;
  let epoch = 0,
    busy = false,
    storageError = loadError,
    writes = Promise.resolve();
  const resume = document.createElement("button");
  resume.id = "resume-review";
  resume.className = "secondary";
  resume.textContent = "Save captured cards to Import";
  document.getElementById("scan").after(resume);
  const update = () => {
    resume.hidden = !id || !rows.some((row) => !row.saved);
    resume.disabled = busy;
  };
  function persist() {
    const value = structuredClone({
      schema: 1,
      id,
      rows,
      revision: ++revision,
      submitted: saved?.submitted || null,
    });
    try {
      reviewCache.journal(account, value);
    } catch {
      storageError = "Saving captured cards on this browser…";
    }
    writes = writes
      .catch(() => {})
      .then(() => reviewCache.write(account, value));
    writes.then(
      () => {
        storageError = "";
      },
      () => {
        storageError =
          "Captured cards could not be saved on this browser. Keep this page open and retry saving to Import.";
        notify(storageError);
      },
    );
    update();
    return writes;
  }
  async function handoff() {
    if (loadError) {
      notify(loadError);
      return;
    }
    if (busy || !rows.length) return;
    const turn = epoch;
    busy = true;
    update();
    notify("Saving captured cards to your pending imports…");
    try {
      await persist();
      // A submitted older local review must settle before its remaining cards migrate.
      if (saved?.submitted) {
        const receipt = await api("/api/collection/batch", {
          method: "POST",
          body: JSON.stringify(saved.submitted),
        });
        if (turn !== epoch) return;
        const committed = new Set(receipt.saved);
        rows = rows.filter(
          (row) => !row.saved && !committed.has(row.operationId),
        );
        saved = null;
        id = crypto.randomUUID();
        await persist();
      }
      if (!rows.length) {
        id = null;
        await persist();
        enter();
        return;
      }
      for (const row of rows) row.captureId ||= crypto.randomUUID();
      await persist();
      const payload = {
        id,
        kind: "scan",
        rows: rows
          .filter((row) => !row.saved)
          .map((row) => ({
            id: row.captureId,
            name: row.selected?.name || row.name || row.raw,
            printing_id: row.selected?.id || null,
            quantity: row.quantity,
            finish: row.finish,
            condition: row.condition || "UNK",
            ...(row.recognition?.length
              ? { recognition: row.recognition }
              : {}),
          })),
      };
      const result = await api("/api/import-draft/stage", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (turn !== epoch) return;
      if (result.staged_id !== id)
        throw Error("Could not confirm this pending import. Retry safely.");
      const stagedId = result.draft?.id;
      id = null;
      rows = [];
      saved = null;
      await persist();
      enter(stagedId);
    } catch (error) {
      if (turn === epoch)
        notify(
          `${error.message} Captured cards remain saved here; use Save captured cards to Import to retry.`,
        );
    } finally {
      if (turn === epoch) {
        busy = false;
        update();
      }
    }
  }
  const scanner = createScanner({
    api,
    recognition: createScanRecognition(api, {
      cloudEnabled: config.backendRecognition === true,
    }),
    onRows: (next) => {
      rows = next;
      void persist().catch(() => {});
    },
    onReview: (next) => {
      rows = next;
      void handoff();
    },
  });
  document.getElementById("scan").onclick = () => {
    if (busy) return;
    if (id && rows.some((row) => !row.saved)) {
      void handoff();
      return;
    }
    if (storageError) {
      notify(storageError);
      return;
    }
    id = crypto.randomUUID();
    rows = [];
    saved = null;
    void persist().catch(() => {});
    scanner.open();
  };
  document.getElementById("scan").disabled = false;
  document.getElementById("scan").removeAttribute("aria-busy");
  resume.onclick = handoff;
  window.addEventListener("keeper-sign-out", () => {
    epoch++;
    rows = [];
    id = null;
    saved = null;
    busy = false;
    update();
  });
  if (location.hash.startsWith("#review=")) {
    history.replaceState(null, "", "#import");
    if (rows.length) void handoff();
    else enter();
  }
  update();
}
