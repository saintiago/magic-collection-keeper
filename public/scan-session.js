// Bounded active journal plus one immutable outgoing batch. Images never persist.
export function compactCapture(row) {
  const card = row.selected;
  return {
    scanId: row.scanId,
    captureId: row.captureId,
    name: row.name,
    quantity: row.quantity,
    finish: row.finish,
    condition: row.condition,
    acceptedIdentity: row.acceptedIdentity || card?.oracle_id,
    userEdited: Boolean(row.userEdited),
    selected: card
      ? {
          id: card.id,
          oracle_id: card.oracle_id,
          name: card.name,
          finishes: card.finishes,
        }
      : null,
    candidates: [],
    recognition: (row.recognition || []).slice(0, 3),
  };
}
export function captureBatch(id, rows) {
  return {
    id,
    kind: "scan",
    rows: rows.map((row) => ({
      id: row.captureId,
      name: row.selected?.name || row.name,
      printing_id: row.selected?.id || null,
      quantity: row.quantity,
      finish: row.finish,
      condition: row.condition || "UNK",
      ...(row.recognition?.length ? { recognition: row.recognition } : {}),
    })),
  };
}
export function createScanSession({
  storage,
  stage,
  newId = () => crypto.randomUUID(),
  saved,
  initialRevision = 0,
}) {
  let state = saved
    ? structuredClone(saved)
    : {
        schema: 2,
        revision: initialRevision,
        id: newId(),
        index: 0,
        rows: [],
        recent: [],
        archived: 0,
        attempt: 0,
        lastOracle: null,
        outgoing: null,
        lastBatch: null,
      };
  const uuid = (value) =>
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    );
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const validRow = (row) =>
    row &&
    uuid(row.captureId) &&
    count(row.scanId) &&
    Number.isSafeInteger(row.quantity) &&
    row.quantity >= 1 &&
    row.quantity <= 100000 &&
    uuid(row.selected?.id) &&
    uuid(row.selected?.oracle_id) &&
    typeof row.selected?.name === "string" &&
    ["nonfoil", "foil", "etched"].includes(row.finish);
  if (
    state.schema !== 2 ||
    !uuid(state.id) ||
    !count(state.revision) ||
    !count(state.attempt) ||
    !count(state.archived) ||
    (state.lastOracle !== null && !uuid(state.lastOracle)) ||
    (state.lastBatch !== null && !uuid(state.lastBatch)) ||
    !Array.isArray(state.rows) ||
    state.rows.length > 50 ||
    !state.rows.every(validRow) ||
    !Array.isArray(state.recent) ||
    state.recent.length > 10 ||
    !state.recent.every(validRow) ||
    !Number.isSafeInteger(state.index) ||
    state.index < 0 ||
    (state.outgoing &&
      (state.outgoing.id !== state.id ||
        state.outgoing.index !== state.index + 1 ||
        !uuid(state.outgoing.batch?.id) ||
        state.outgoing.last_oracle !== state.lastOracle ||
        JSON.stringify(state.outgoing.batch) !==
          JSON.stringify(captureBatch(state.outgoing.batch.id, state.rows))))
  )
    throw Error(
      "Saved scan could not be loaded safely. Keep this page and retry recovery.",
    );
  let pendingWrite = null,
    writing = null,
    writeError = null,
    sealing = null;
  let revision = state.revision || 0;
  function drainWrites() {
    if (writing) return writing;
    writing = (async () => {
      while (pendingWrite) {
        const next = pendingWrite;
        pendingWrite = null;
        try {
          await storage.write(next);
          writeError = null;
        } catch (error) {
          writeError = error;
          throw error;
        }
      }
    })().finally(() => {
      writing = null;
    });
    return writing;
  }
  async function persist() {
    state = { ...state, revision: ++revision };
    const snapshot = structuredClone(state);
    // A failed synchronous fallback may still be recovered by IndexedDB.
    let journalError;
    try {
      storage.journal(snapshot);
    } catch (error) {
      journalError = error;
    }
    pendingWrite = snapshot;
    await drainWrites();
    if (pendingWrite) await drainWrites();
    if (writeError) throw writeError;
    if (journalError && !storage.write) throw journalError;
  }
  const current = () => structuredClone(state);
  return {
    current,
    async checkpoint(rows, metadata = {}) {
      if (rows.length > 50) throw Error("Wait for the current batch to save.");
      if (state.outgoing) return; // Frozen retry payload cannot be replaced.
      state = {
        ...state,
        rows: rows.map(compactCapture),
        attempt: metadata.attempt ?? state.attempt,
        lastOracle: metadata.lastOracle ?? state.lastOracle,
      };
      await persist();
    },
    async seal(rows, metadata = {}) {
      if (sealing) return sealing;
      sealing = (async () => {
        if (!state.outgoing) {
          if (!rows.length) return current();
          if (rows.length > 50)
            throw Error("A scan batch exceeds its safe size.");
          state.rows = rows.map(compactCapture);
          state.lastOracle = metadata.lastOracle ?? state.lastOracle;
          state.attempt = metadata.attempt ?? state.attempt;
          state.outgoing = {
            id: state.id,
            index: state.index + 1,
            last_oracle: state.lastOracle,
            batch: captureBatch(newId(), state.rows),
          };
        }
        await persist(); // Never send an operation without durable retry identity.
        const outgoing = state.outgoing;
        const result = await stage(outgoing);
        if (
          result.staged_id !== outgoing.batch.id ||
          result.session_id !== state.id ||
          result.index !== outgoing.index
        )
          throw Error("Could not confirm this saved batch. Retry safely.");
        const before = state;
        state = {
          ...state,
          index: outgoing.index,
          archived: state.archived + state.rows.length,
          recent: state.rows
            .slice(-10)
            .map((row) => ({ ...row, archived: true })),
          lastBatch: outgoing.batch.id,
          rows: [],
          outgoing: null,
        };
        try {
          await persist();
        } catch (error) {
          state = before;
          throw error;
        } // Replay the same server receipt.
        return current();
      })().finally(() => {
        sealing = null;
      });
      return sealing;
    },
  };
}
