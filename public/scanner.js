import { scannerShell } from "./scan-view.js";
import { startCamera, stopCamera, capture, signature } from "./camera.js";
import { recognizeCard, stopRecognition } from "./recognition.js";
import { createTransitionGate } from "./scan-transition.js";
import { resolveScan } from "./scan-resolution.js";
import { createScanAudio } from "./scan-audio.js";
import { createScanWheel } from "./scan-wheel.js";

export function createScanner({ api, onReview }) {
  const dialog = document.createElement("dialog");
  dialog.className = "scanner-dialog";
  dialog.setAttribute("aria-label", "Continuous card scanner");
  document.body.append(dialog);
  let rows,
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
      `${rows.length} readings · ${rows.reduce((n, r) => n + r.quantity, 0)} copies`;
    el("scan-empty").hidden = rows.length > 0;
  }
  function stop() {
    session++;
    running = false;
    dialog.dataset.running = "false";
    processing = false;
    clearTimeout(timer);
    stopCamera(stream);
    stream = undefined;
    const video = el("camera-video");
    if (video) video.srcObject = null;
    queue = [];
    for (const row of rows || [])
      if (row.processing) {
        row.processing = false;
        row.error = "Reading interrupted. Review this card before saving.";
      }
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
  function enqueue(canvas) {
    if (rows.length >= 50) {
      stop();
      update();
      status("50 readings ready. Tap Review to save this batch.");
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
    rows.push(row);
    update(true);
    if (queue.length >= 3) {
      row.processing = false;
      row.name = "Card needs another look";
      row.error =
        "Cards arrived faster than recognition. Review this card or scan it again.";
      audio.cue("error", row.scanId);
      update();
      status(row.error);
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
      if (!rows.includes(row)) continue;
      let result;
      try {
        status("Reading card locally… Keep each card still until the cue.");
        const reading = await recognizeCard(canvas);
        if (current !== session) return;
        result = await resolveScan(reading, api);
      } catch (error) {
        result = {
          name: "Unclear reading",
          error: `Recognition failed: ${error.message}. Review this card later.`,
          selected: null,
        };
      }
      if (current !== session || !dialog.open) return;
      if (!rows.includes(row)) continue;
      const quantity = row.quantity;
      Object.assign(row, result, { quantity, processing: false });
      audio.cue(row.selected ? "success" : "error", row.scanId);
      update(row === rows.at(-1));
      status(
        row.selected
          ? `${row.name} matched. Slide in the next card.`
          : `${row.error} Scanning can continue.`,
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
    let soundReady = false;
    void audio.activate().then((ready) => {
      soundReady = ready;
    });
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
        `Hold one card inside the guide until the cue, then slide in the next.${soundReady ? "" : " Use the visual status if sound is unavailable."}`,
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
      queue = [];
      attempt = 0;
      audio = createScanAudio();
      audio.setMuted(muted);
      dialog.innerHTML = scannerShell(muted);
      wheel = createScanWheel({
        viewport: el("scan-wheel"),
        controls: el("scan-controls"),
        onChange: () => update(),
      });
      el("camera-start").onclick = start;
      el("scan-back").onclick = leave;
      el("scan-review").onclick = leave;
      el("scan-mute").onclick = async () => {
        muted = !muted;
        audio.setMuted(muted);
        el("scan-mute").setAttribute("aria-pressed", String(muted));
        el("scan-mute").textContent = muted ? "Sound off" : "Sound on";
        if (!muted) await audio.activate();
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
      dialog.showModal();
      update();
    },
  };
}
