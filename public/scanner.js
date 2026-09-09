import { scannerShell } from "./scan-view.js";
import { startCamera, stopCamera, capture, signature } from "./camera.js";
import { createScanAdmission } from "./scan-admission.js";
import { createFrameBurst, captureQuality } from "./camera-quality.js";
import { createScanAudio } from "./scan-audio.js";
import { createScanWheel } from "./scan-wheel.js";
import { createCardPresence } from "./card-presence.js";
import { createScanOverlay } from "./scan-overlay.js";

export function createScanner({
  api,
  onReview,
  onRows = () => {},
  recognition = null,
}) {
  const mode = recognition?.kind || "hybrid";
  const presence = createCardPresence();
  let requestController = new AbortController();
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
    burst,
    overlay,
    running = false,
    processing = false,
    session = 0,
    attempt = 0,
    muted = false,
    preparationAttempt = 0;
  let presenceTask = null;
  let checkedFrame = null;
  const el = (id) => dialog.querySelector(`#${id}`);
  const status = (text) => {
    if (dialog.open && el("scan-status").textContent !== text)
      el("scan-status").textContent = text;
  };
  function prepareRecognition() {
    void presence.prepare().catch(() => {});
    if (recognition?.kind !== "hybrid") return;
    const id = ++preparationAttempt;
    let label = el("scan-preparation");
    if (!label) {
      label = document.createElement("p");
      label.id = "scan-preparation";
      label.className = "scan-ready-state";
      label.setAttribute("aria-live", "polite");
      el("scan-status").before(label);
    }
    label.textContent =
      "Preparing faster recognition… You can start the camera.";
    recognition.prepare().then(
      () => {
        if (dialog.open && id === preparationAttempt)
          label.textContent = "Scanner ready.";
      },
      () => {
        if (dialog.open && id === preparationAttempt)
          label.textContent =
            "Recognition unavailable. Check your connection and retry.";
      },
    );
  }
  function update(newest = false) {
    wheel.update(rows, newest);
    el("scan-count").textContent =
      `${rows.length} queued · ${rows.reduce((n, r) => n + r.quantity, 0)} copies`;
    el("scan-empty").hidden = rows.length > 0;
    el("scan-review").disabled = rows.length === 0;
    onRows(rows);
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
  function stop() {
    session++;
    requestController.abort();
    requestController = new AbortController();
    presence.dispose();
    presenceTask = null;
    checkedFrame = null;
    overlay?.clear();
    running = false;
    dialog.dataset.running = "false";
    processing = false;
    clearTimeout(timer);
    stopCamera(stream);
    stream = undefined;
    const video = el("camera-video");
    if (video) video.srcObject = null;
    queue = [];
    burst?.clear();
    void audio?.close();
    if (el("camera-start")) {
      el("camera-start").hidden = false;
      el("camera-start").disabled = false;
    }
  }
  function leave() {
    stop();
    recognition?.dispose?.();
    const overlayMetrics = overlay?.destroy();
    if (overlayMetrics)
      window.dispatchEvent(
        new CustomEvent("keeper-overlay-measurement", {
          detail: overlayMetrics,
        }),
      );
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
      recognition?.dispose?.();
      update();
      status("Camera paused in the background. Tap Start camera to resume.");
    }
  });
  window.addEventListener("pagehide", () => {
    stop();
    recognition?.dispose?.();
    overlay?.destroy();
    overlay = null;
  });
  window.addEventListener("keeper-sign-out", () => {
    stop();
    recognition?.dispose?.();
    overlay?.destroy();
    dialog.close();
    document.documentElement.classList.remove("scanning");
  });
  function enqueue(canvas) {
    if (rows.length + queue.length + Number(processing) >= 50) {
      stop();
      update();
      status("Batch full. Open Review to check and save these cards.");
      return;
    }
    const row = {
      scanId: ++attempt,
      captureId: crypto.randomUUID(),
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
    queue.push({ row, canvas, capturedAt: performance.now() });
    overlay?.capture(row.captureId, signature(canvas), canvas.cardGeometry);
    void drain(session);
  }
  async function drain(current) {
    if (processing) return;
    processing = true;
    while (queue.length && current === session && dialog.open) {
      const { row, canvas, capturedAt } = queue.shift();
      const began = performance.now();
      let failure = null;
      let result;
      try {
        status(
          recognition
            ? "Reading card… Keep each card still until the cue."
            : "Reading card locally… Keep each card still until the cue.",
        );
        result = await recognition.recognize(canvas, {
          attempt: row.scanId,
          onStage: (stage) => {
            if (current === session && dialog.open)
              overlay?.stage(row.captureId, stage);
          },
          onUpdate: (verified) => {
            if (current !== session || !dialog.open || !verified.selected)
              return;
            if (row.processing) {
              row.latestRecognition = verified;
              return;
            }
            if (!rows.includes(row)) return;
            const chosen = row.selected,
              quantity = row.quantity;
            const edited = row.userEdited
              ? {
                  selected: chosen,
                  name: chosen.name,
                  finish: row.finish,
                  condition: row.condition,
                  query: row.query,
                }
              : {};
            Object.assign(row, verified, { quantity, ...edited });
            overlay?.recognized(row.captureId, row.name);
            update();
          },
          signal: AbortSignal.any([
            requestController.signal,
            AbortSignal.timeout(35000),
          ]),
        });
        if (current === session && dialog.open && el("scan-preparation"))
          el("scan-preparation").textContent = "Scanner ready.";
      } catch (error) {
        failure = { name: error.name, status: error.status || null };
        result = {
          name: "Unclear reading",
          error:
            error.code === "SCANNER_PREPARING"
              ? "Scanner is still preparing. Wait for Ready, then move the card out and retry."
              : "Recognition failed. Move the card out, then try again.",
          selected: null,
        };
      }
      if (current !== session || !dialog.open) return;
      const quantity = row.quantity;
      Object.assign(row, row.latestRecognition || result, {
        quantity,
        processing: false,
      });
      delete row.latestRecognition;
      if (row.selected) rows.push(row);
      if (row.selected) overlay?.recognized(row.captureId, row.name);

      if (!row.waitingForSingleCard)
        audio.cue(row.selected ? "success" : "error", row.scanId);
      update(Boolean(row.selected));
      status(
        row.waitingForSingleCard
          ? "Wait until only one card is visible."
          : row.selected
            ? `${row.name} queued · check suggested printing in Review. ${running ? "Slide in the next card." : "Upload another photo or start the camera."}`
            : row.candidates?.length
              ? "Identity uncertain. Move the card out and retry. No copy counted."
              : `${row.error || "No match. Move the card out, then try again."} No copy counted.`,
      );
      window.dispatchEvent(
        new CustomEvent("keeper-scan-measurement", {
          detail: {
            mode,
            attempt: row.scanId,
            captureToCandidateMs: performance.now() - capturedAt,
            processingAndHydrationMs: performance.now() - began,
            queueMs: began - capturedAt,
            outcome: failure
              ? "error"
              : row.selected
                ? "selected"
                : row.candidates?.length
                  ? "possible"
                  : "unknown",
            failure,
            selected: row.selected?.id || null,
            candidates:
              row.candidates?.map((c) => ({
                id: c.id,
                oracle_id: c.oracle_id,
              })) || [],
            ...row.measurement,
          },
        }),
      );
    }
    if (current === session) processing = false;
  }
  function tick(current) {
    if (!running || current !== session) return;
    const tickStarted = performance.now();
    try {
      const video = el("camera-video");
      if (video.readyState >= 2) {
        const canvas = capture(video, el("scan-guide"));
        const frame = signature(canvas),
          now = performance.now();
        canvas.capturedAt = now;
        gate.track(frame, now);
        overlay?.track(frame);
        burst.observe(canvas, frame, now, captureQuality(canvas));
        if (
          checkedFrame &&
          gate.validate(
            checkedFrame.frame,
            checkedFrame.at,
            checkedFrame.geometry.state,
          )
        )
          enqueue(checkedFrame.canvas);
        if (!presenceTask) {
          const sample = burst.take() || canvas;
          const sampled = signature(sample),
            capturedAt = sample.capturedAt;
          const task = presence.inspect(sample, {
            signal: AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(12000),
            ]),
          });
          presenceTask = task;
          task
            .then(
              (geometry) => {
                if (
                  !running ||
                  current !== session ||
                  !dialog.open ||
                  !gate.matches(sampled, capturedAt)
                )
                  return;
                sample.cardGeometry = geometry;
                checkedFrame = {
                  canvas: sample,
                  frame: sampled,
                  at: capturedAt,
                  geometry,
                };
                overlay?.observe(geometry, sampled);
                if (geometry.state !== "single") {
                  status(
                    geometry.state === "none"
                      ? "Place one card inside the guide."
                      : "Wait until only one card is visible.",
                  );
                }
                if (gate.validate(sampled, capturedAt, geometry.state))
                  enqueue(sample);
              },
              (error) => {
                if (current !== session || error.name === "AbortError") return;
                stop();
                update();
                status(`Camera paused: ${error.message}`);
              },
            )
            .finally(() => {
              if (presenceTask === task) presenceTask = null;
            });
        }
      }
    } catch (error) {
      if (current !== session || error.name === "AbortError") return;
      stop();
      update();
      status(`Camera paused: ${error.message}`);
    }
    if (running && current === session)
      timer = setTimeout(
        () => tick(current),
        Math.max(0, 120 - (performance.now() - tickStarted)),
      );
  }
  async function start() {
    prepareRecognition();
    stop();
    update();
    const current = session;
    gate = createScanAdmission();
    burst = createFrameBurst();
    el("camera-start").disabled = true;
    status("Waiting for camera permission…");
    // Called directly from the initial tap, before awaiting camera permission.
    void audio.activate({ test: true });
    try {
      const candidate = await startCamera(el("camera-video"), {
        signal: requestController.signal,
        onDiagnostics: (detail) =>
          window.dispatchEvent(
            new CustomEvent("keeper-camera-measurement", { detail }),
          ),
      });
      if (current !== session || !dialog.open || document.hidden) {
        stopCamera(candidate);
        return;
      }
      stream = candidate;
      if (!overlay)
        overlay = createScanOverlay({
          canvas: el("scan-overlay"),
          video: el("camera-video"),
          guide: el("scan-guide"),
        });
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
      queue = [];
      attempt = 0;
      dialog.innerHTML = scannerShell(muted);
      overlay?.destroy();
      overlay = createScanOverlay({
        canvas: el("scan-overlay"),
        video: el("camera-video"),
        guide: el("scan-guide"),
      });
      dialog.dataset.recognition = recognition ? "backend" : "local";
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
          const geometry = await presence.inspect(canvas, {
            signal: AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(12000),
            ]),
          });
          if (current !== session || !dialog.open) return;
          if (geometry.state !== "single") {
            status(
              geometry.state === "none"
                ? "No clear card found. Choose a photo of one card."
                : "Wait until only one card is visible.",
            );
            return;
          }
          enqueue(canvas);
        } catch (error) {
          if (current === session && dialog.open) {
            status(`Could not read that image: ${error.message}`);
            audio.cue("error", ++attempt);
          }
        } finally {
          event.target.value = "";
        }
      };
      document.documentElement.classList.add("scanning");
      dialog.showModal();
      prepareRecognition();
      el("camera-start").focus();
      update();
    },
  };
}
