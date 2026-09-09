import { parseList } from "./import.js";
import { listQuery } from "./catalog-query.js";
import { batchShell, reviewRows } from "./batch-view.js";
import { createScanner } from "./scanner.js";
import { config } from "./auth.js";
import { createScanRecognition } from "./scan-recognition.js";
export function setupBatch({ api, onSaved }) {
  let rows = [],
    busy = false;
  const dialog = document.createElement("dialog");
  dialog.className = "batch-dialog";
  document.body.append(dialog);

  dialog.addEventListener("cancel", (e) => {
    if (busy) {
      e.preventDefault();
      return;
    }
    if (
      rows.some((r) => !r.saved) &&
      !confirm("Discard this unsaved review batch?")
    )
      e.preventDefault();
  });
  const el = (id) => dialog.querySelector(`#${id}`);
  const status = (text) => {
    el("batch-status").textContent = text;
  };
  function open(type, initialRows = []) {
    rows = initialRows;
    dialog.innerHTML = batchShell(type);
    el("batch-close").onclick = () => {
      if (busy) {
        status("Please wait for the current operation to finish.");
        return;
      }
      if (
        !rows.some((r) => !r.saved) ||
        confirm("Discard this unsaved review batch?")
      )
        dialog.close();
    };
    el("ownership").onchange = () => {
      el("save-batch").disabled =
        !el("ownership").checked ||
        busy ||
        !rows.some((r) => r.selected && !r.saved);
    };
    el("save-batch").onclick = save;
    if (type === "import") el("preview").onclick = preview;
    dialog.showModal();
    render();
  }
  async function resolve(row) {
    row.selected = null;
    try {
      const data = await api(
        `/api/search?${new URLSearchParams({ q: row.query })}`,
      );
      row.candidates = data.cards;
      row.selected = data.cards.length === 1 ? data.cards[0] : null;
      if (row.selected && !row.selected.finishes.includes(row.finish))
        row.finish = row.selected.finishes[0];
      row.error = data.cards.length
        ? null
        : "No match. Edit the search text and try again.";
      if (data.hasMore)
        row.note =
          "More printings exist. Add set: and cn: to narrow your search.";
    } catch (e) {
      row.error = e.message;
    }
  }
  async function preview() {
    const parsed = parseList(el("import-text").value);
    if (!parsed.length) {
      status("Paste at least one card line.");
      return;
    }
    if (parsed.length > 50) {
      status("Please split this list into batches of 50 card lines or fewer.");
      return;
    }
    rows = parsed.map((r) => ({
      ...r,
      query: r.error ? r.raw : listQuery(r),
      condition: "NM",
      candidates: [],
    }));
    busy = true;
    el("preview").disabled = true;
    el("save-batch").disabled = true;
    el("ownership").checked = false;
    for (let i = 0; i < rows.length; i++) {
      status(`Matching line ${i + 1} of ${rows.length}…`);
      if (!rows[i].error) await resolve(rows[i]);
      render();
    }
    busy = false;
    el("preview").disabled = false;
    status(
      "Review matches below. Unresolved lines are not added. Name-only lists need an explicit printing choice.",
    );
    render();
  }
  function updateSave() {
    el("save-batch").disabled =
      busy ||
      !el("ownership").checked ||
      !rows.some((r) => r.selected && !r.saved);
  }
  function render() {
    el("batch-rows").innerHTML = reviewRows(rows, busy);
    el("batch-rows")
      .querySelectorAll(".review-row")
      .forEach((section) => {
        const row = rows[Number(section.dataset.row)];
        if (row.saved) return;
        section.querySelector(".candidate").onchange = (e) => {
          row.selected =
            row.candidates.find((c) => c.id === e.target.value) || null;
          if (row.selected && !row.selected.finishes.includes(row.finish))
            row.finish = row.selected.finishes[0];
          el("ownership").checked = false;
          render();
          updateSave();
        };
        section.querySelector(".review-qty").oninput = (e) => {
          row.quantity = Number(e.target.value);
          el("ownership").checked = false;
          updateSave();
        };
        section.querySelector(".review-finish").onchange = (e) => {
          row.finish = e.target.value;
          el("ownership").checked = false;
          updateSave();
        };
        section.querySelector(".review-condition").onchange = (e) => {
          row.condition = e.target.value;
          el("ownership").checked = false;
          updateSave();
        };
        section.querySelector(".resolve").onclick = async () => {
          if (busy) return;
          row.query = section
            .querySelector(".review-search input")
            .value.trim();
          busy = true;
          updateSave();
          await resolve(row);
          busy = false;
          render();
          updateSave();
        };
      });
    updateSave();
  }
  async function save() {
    busy = true;
    updateSave();
    let saved = 0;
    let failure;
    try {
      for (const row of rows.filter((r) => r.selected && !r.saved)) {
        row.operationId ||= crypto.randomUUID();
        status(`Saving reviewed card ${saved + 1}…`);
        await api("/api/collection", {
          method: "POST",
          body: JSON.stringify({
            printing_id: row.selected.id,
            quantity: row.quantity,
            finish: row.finish,
            condition: row.condition,
            operation_id: row.operationId,
          }),
        });
        row.saved = true;
        saved++;
        render();
      }
    } catch (e) {
      failure = e;
    }
    try {
      await onSaved();
    } catch (error) {
      failure ||= error;
    }
    busy = false;
    render();
    status(
      failure
        ? `${saved} entries saved before an error: ${failure.message} Saved entries will not be added again when you retry.`
        : `${saved} reviewed entries added. Unselected or unresolved lines were left out.`,
    );
  }
  const scanner = createScanner({
    api,
    recognition: createScanRecognition(api, {
      cloudEnabled: config.backendRecognition === true,
    }),
    onReview: (scanned) => open("review", scanned),
  });
  document.getElementById("scan").onclick = () => scanner.open();
  document.getElementById("import-list").onclick = () => open("import");
}
