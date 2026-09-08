import { scannerShell, possibleMatches } from "./scan-view.js";
import { startCamera, stopCamera, capture, signature } from "./camera.js";
import { recognizeCard, stopRecognition } from "./recognition.js";
import { createTransitionGate } from "./scan-transition.js";
import { resolveScan } from "./scan-resolution.js";
import { createScanAudio } from "./scan-audio.js";
import { createScanWheel } from "./scan-wheel.js";

export function createScanner({ api, onReview, recognition = null }) {
  let requestController = new AbortController();
  const dialog = document.createElement("dialog");
  dialog.className = "scanner-dialog";
  dialog.setAttribute("aria-label", "Continuous card scanner");
  document.body.append(dialog);
  let rows,
    possible,
    queue,
    wheel,
    audio,
    stream,
    timer,
    gate,
    running = false,
    processing = false,
    session = 0,
    attempt = 0,
    muted = false;
  const el = (id) => dialog.querySelector(`#${id}`);
  const status = (text) => {
    if (dialog.open) el("scan-status").textContent = text;
  };
  function update(newest = false) {
    wheel.update(rows, newest);
    el("scan-count").textContent =
      `${rows.length} matched · ${rows.reduce((n, r) => n + r.quantity, 0)} copies`;
    el("scan-empty").hidden = rows.length > 0;
    el("scan-review").disabled = rows.length === 0;
    renderPossible();
  }
  function soundState(state) {
    if (!el("scan-sound-state")) return;
    el("scan-sound-state").textContent =
      {
        running: "Audio ready · check your device volume",
        muted: "Sound muted",
        inactive: "Sound not activated",
        suspended: "Sound paused · tap Test sound",
        interrupted: "Sound interrupted · tap Test sound",
        closed: "Sound stopped",
        unavailable: "Sound unavailable · follow visual status",
      }[state] || "Sound unavailable · follow visual status";
  }
  function renderPossible() {
    const panel = el("scan-possible");
    panel.hidden = !possible.length;
    panel.querySelector("summary").textContent =
      `Possible matches (${possible.length})`;
    panel.querySelector(".scan-possible-list").innerHTML =
      possibleMatches(possible);
  }
  function stop() {
    session++;
    requestController.abort();
    requestController = new AbortController();
    running = false;
    dialog.dataset.running = "false";
    processing = false;
    clearTimeout(timer);
    stopCamera(stream);
    stream = undefined;
    const video = el("camera-video");
    if (video) video.srcObject = null;
    queue = [];
    void stopRecognition();
    void audio?.close();
    if (el("camera-start")) {
      el("camera-start").hidden = false;
      el("camera-start").disabled = false;
    }
  }
  function leave() {
    stop();
    wheel.destroy();
    dialog.close();
    document.documentElement.classList.remove("scanning");
    if (rows.length) onReview(rows);
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    leave();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && dialog.open) {
      stop();
      update();
      status("Camera paused in the background. Tap Start camera to resume.");
    }
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("keeper-sign-out", () => {
    stop();
    dialog.close();
    document.documentElement.classList.remove("scanning");
  });
  function enqueue(canvas) {
    if (
      rows.length + possible.length + queue.length + Number(processing) >=
      50
    ) {
      stop();
      update();
      status("Batch full. Review matched cards or dismiss possible matches.");
      return;
    }
    const row = {
      scanId: ++attempt,
      name: "Reading card",
      quantity: 1,
      candidates: [],
      selected: null,
      query: "",
      finish: "nonfoil",
      condition: "NM",
      processing: true,
    };
    if (queue.length >= 3) {
      audio.cue("error", row.scanId);
      status(
        "Scanning is busy. Move this card out, then try again after the cue.",
      );
      return;
    }
    queue.push({ row, canvas });
    void drain(session);
  }
  async function drain(current) {
    if (processing) return;
    processing = true;
    while (queue.length && current === session && dialog.open) {
      const { row, canvas } = queue.shift();
      let result;
      try {
        status(
          recognition
            ? "Reading card securely… Keep each card still until the cue."
            : "Reading card locally… Keep each card still until the cue.",
        );
        if (recognition) {
          result = await recognition.recognize(canvas, {
            attempt: row.scanId,
            signal: AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(25000),
            ]),
          });
        } else {
          const reading = await recognizeCard(canvas);
          if (current !== session) return;
          result = await resolveScan(reading, api);
        }
      } catch (error) {
        result = {
          name: "Unclear reading",
          error: "Recognition failed. Move the card out, then try again.",
          selected: null,
        };
      }
      if (current !== session || !dialog.open) return;
      const quantity = row.quantity;
      Object.assign(row, result, { quantity, processing: false });
      if (row.selected) rows.push(row);
      else if (row.candidates?.length) {
        possible.push(row);
        if (possible.length > 10) possible.shift();
      }
      audio.cue(row.selected ? "success" : "error", row.scanId);
      update(Boolean(row.selected));
      status(
        row.selected
          ? `${row.name} matched. ${running ? "Slide in the next card." : "Upload another photo or start the camera."}`
          : row.candidates?.length
            ? "Printing uncertain. Move the card out and retry, or open Possible matches. No copy counted."
            : `${row.error || "No match. Move the card out, then try again."} No copy counted.`,
      );
    }
    if (current === session) processing = false;
  }
  function tick(current) {
    if (!running || current !== session) return;
    try {
      const video = el("camera-video");
      if (video.readyState >= 2) {
        const canvas = capture(video, el("scan-guide"));
        if (gate.observe(signature(canvas), performance.now())) enqueue(canvas);
      }
    } catch (error) {
      stop();
      update();
      status(`Camera paused: ${error.message}`);
    }
    if (running && current === session)
      timer = setTimeout(() => tick(current), 120);
  }
  async function start() {
    stop();
    update();
    const current = session;
    gate = createTransitionGate();
    el("camera-start").disabled = true;
    status("Waiting for camera permission…");
    // Called directly from the initial tap, before awaiting camera permission.
    void audio.activate({ test: true });
    try {
      const candidate = await startCamera(el("camera-video"));
      if (current !== session || !dialog.open || document.hidden) {
        stopCamera(candidate);
        return;
      }
      stream = candidate;
      running = true;
      dialog.dataset.running = "true";
      el("camera-start").hidden = true;
      status(
        "Hold one card inside the guide until the cue, then slide in the next.",
      );
      tick(current);
    } catch (error) {
      if (current === session) status(error.message);
    } finally {
      if (current === session) el("camera-start").disabled = false;
    }
  }
  return {
    open() {
      rows = [];
      possible = [];
      queue = [];
      attempt = 0;
      dialog.innerHTML = scannerShell(muted);
      dialog.dataset.recognition = recognition ? "backend" : "local";
      if (recognition) {
        const notice = document.createElement("p");
        notice.className = "recognition-notice";
        notice.textContent =
          "Card crops are sent securely for recognition, processed in memory and not saved. ";
        const source = document.createElement("button");
        source.textContent = "Recognition source (AGPL-3.0)";
        source.onclick = async () => {
          const current = session;
          source.disabled = true;
          try {
            const blob = await api("/api/recognition/source", {
              responseType: "blob",
              signal: requestController.signal,
            });
            if (current !== session || !dialog.open) return;
            const url = URL.createObjectURL(blob),
              link = document.createElement("a");
            link.href = url;
            link.download = "keeper-recognition-source.zip";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch {
            if (current === session)
              status("Source download unavailable. Please retry.");
          } finally {
            source.disabled = false;
          }
        };
        notice.append(source);
        el("scan-status").before(notice);
      }
      audio = createScanAudio({ onState: soundState });
      audio.setMuted(muted);
      wheel = createScanWheel({
        viewport: el("scan-wheel"),
        controls: el("scan-controls"),
        onChange: () => update(),
      });
      el("camera-start").onclick = start;
      el("scan-back").onclick = leave;
      el("scan-review").onclick = leave;
      el("scan-test-sound").onclick = () => {
        muted = false;
        audio.setMuted(false);
        el("scan-mute").setAttribute("aria-pressed", "false");
        el("scan-mute").textContent = "Mute sound";
        void audio.activate({ test: true });
      };
      el("scan-possible").onclick = (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const id = Number(button.dataset.attempt || button.dataset.dismiss);
        const index = possible.findIndex((row) => row.scanId === id);
        if (index < 0) return;
        const row = possible[index];
        if (button.dataset.candidate !== undefined) {
          row.selected = row.candidates[Number(button.dataset.candidate)];
          row.name = row.selected.name;
          row.error = null;
          if (!row.selected.finishes.includes(row.finish))
            row.finish = row.selected.finishes[0];
          rows.push(row);
          rows.sort((a, b) => a.scanId - b.scanId);
          status(
            `${row.name} selected for final printing and ownership review.`,
          );
        }
        possible.splice(index, 1);
        update(true);
      };
      el("scan-mute").onclick = async () => {
        muted = !muted;
        audio.setMuted(muted);
        el("scan-mute").setAttribute("aria-pressed", String(muted));
        el("scan-mute").textContent = muted ? "Enable sound" : "Mute sound";
        if (!muted) await audio.activate({ test: true });
      };
      el("photo").onchange = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        stop();
        update();
        const current = session;
        void audio.activate();
        try {
          const bitmap = await createImageBitmap(file);
          if (current !== session || !dialog.open) {
            bitmap.close();
            return;
          }
          const canvas = document.createElement("canvas"),
            scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
          canvas.width = bitmap.width * scale;
          canvas.height = bitmap.height * scale;
          canvas
            .getContext("2d")
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          enqueue(canvas);
        } catch (error) {
          status(`Could not read that image: ${error.message}`);
          audio.cue("error", ++attempt);
        }
        event.target.value = "";
      };
      document.documentElement.classList.add("scanning");
      dialog.showModal();
      el("camera-start").focus();
      update();
    },
  };
}
