import { parseList } from "./import.js";
import { listQuery, recognitionQuery } from "./catalog-query.js";
import { batchShell, reviewRows } from "./batch-view.js";
import {
  startCamera,
  stopCamera,
  capture,
  signature,
  frameDifference,
} from "./camera.js";
import { recognizeCard } from "./recognition.js";
export function setupBatch({ api, onSaved }) {
  let rows = [],
    stream,
    timer,
    active = false,
    busy = false,
    lastFrame,
    stable = 0,
    lastRead = "",
    armed = true;
  const dialog = document.createElement("dialog");
  let cameraGeneration = 0;
  dialog.className = "batch-dialog";
  document.body.append(dialog);
  function stop() {
    cameraGeneration++;
    active = false;
    clearTimeout(timer);
    stopCamera(stream);
    stream = undefined;
  }
  dialog.addEventListener("close", stop);
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
  function open(type) {
    rows = [];
    lastFrame = null;
    lastRead = "";
    armed = true;
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
    else {
      el("camera-start").onclick = async () => {
        el("camera-start").disabled = true;
        status("Waiting for camera permission…");
        try {
          stop();
          const generation = cameraGeneration;
          const candidateStream = await startCamera(el("camera-video"));
          if (generation !== cameraGeneration || !dialog.open) {
            stopCamera(candidateStream);
            return;
          }
          stream = candidateStream;
          active = true;
          status("Camera running. Hold a card still inside the guide.");
          tick();
        } catch (e) {
          status(e.message);
        } finally {
          el("camera-start").disabled = false;
        }
      };
      el("camera-stop").onclick = () => {
        stop();
        status("Camera paused. You can review your batch.");
      };
      el("next-card").onclick = () => {
        armed = true;
        lastRead = "";
        stable = 0;
        lastFrame = null;
        status(
          "Ready for the next physical card, including another copy of the same printing.",
        );
      };
      el("photo").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (busy) {
          status("Wait for the current reading before uploading.");
          return;
        }
        stop();
        try {
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement("canvas");
          const scale = Math.min(
            1,
            2000 / Math.max(bitmap.width, bitmap.height),
          );
          canvas.width = bitmap.width * scale;
          canvas.height = bitmap.height * scale;
          canvas
            .getContext("2d")
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          armed = true;
          await read(canvas);
        } catch (e) {
          status(`Could not read that image: ${e.message}`);
        }
      };
    }
    dialog.showModal();
  }
  async function tick() {
    if (!active) return;
    try {
      if (!busy && el("camera-video").readyState >= 2) {
        const canvas = capture(el("camera-video")),
          current = signature(canvas),
          change = frameDifference(lastFrame, current);
        lastFrame = current;
        stable = change < 7 ? stable + 1 : 0;
        if (change > 18) armed = true;
        if (stable >= 3 && armed) {
          stable = 0;
          armed = false;
          await read(canvas);
        }
      }
    } catch (e) {
      status(e.message);
    }
    if (active) timer = setTimeout(tick, 600);
  }
  async function resolve(row) {
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
  async function read(canvas) {
    busy = true;
    el("save-batch").disabled = true;
    try {
      status(
        "Reading card locally… The first scan loads the English OCR model.",
      );
      const result = await recognizeCard(canvas, (text) =>
        status(`Reading card: ${text}…`),
      );
      const key = result.exact
        ? `${result.exact.set}/${result.exact.number}`
        : result.name.toLowerCase();
      if (key && key === lastRead) {
        status(
          "Same card still visible. Move to a different card, or press “Next physical card” for another copy.",
        );
        return;
      }
      if (rows.length >= 50) {
        stop();
        status("Review and save this 50-card batch before continuing.");
        return;
      }
      lastRead = key;
      const q = recognitionQuery(result);
      const row = {
        quantity: 1,
        name: result.name || "Unclear reading",
        query: q,
        finish: "nonfoil",
        condition: "NM",
        candidates: [],
        ocr: result.text,
        confidence: result.confidence,
      };
      rows.push(row);
      if (q) {
        status("Finding possible printings…");
        await resolve(row);
        if (result.exact && result.name && row.error?.startsWith("No match.")) {
          row.query = result.name;
          await resolve(row);
          row.note =
            "The footer did not match. These candidates use the recognized name; choose the exact printing.";
        }
      } else
        row.error =
          "Could not read a name or collector number. Type a name or set: code and cn: number below.";
      render();
      status(
        "Reading added to review. Check the card image and exact printing.",
      );
    } catch (e) {
      status(
        `Recognition failed: ${e.message}. Try a sharper photo or use Discover cards.`,
      );
    } finally {
      busy = false;
      render();
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
    stop();
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
  document.getElementById("scan").onclick = () => open("scan");
  document.getElementById("import-list").onclick = () => open("import");
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && active) {
      stop();
      status("Camera paused while the app is in the background.");
    }
  });
}
