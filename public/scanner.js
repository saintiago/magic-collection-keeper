import { scannerShell } from "./scan-view.js";
import { startCamera, stopCamera, capture, signature } from "./camera.js";
import { createScanAdmission } from "./scan-admission.js";
import { createScanSequence } from "./scan-sequence.js";
import { visualDifference } from "./scan-transition.js";
import { createScanAudio } from "./scan-audio.js";
import { createScanWheel } from "./scan-wheel.js";
import { createCardPresence } from "./card-presence.js";
import { createScanOverlay } from "./scan-overlay.js";

export function createScanner({
  api,
  onReview,
  onRows = () => {},
  onBatch = null,
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
    sequence,
    overlay,
    running = false,
    processing = false,
    session = 0,
    attempt = 0,
    muted = false,
    preparationAttempt = 0;
  let presenceTask = null;
  let nextReadingAt = 0,
    nextGeometryAt = 0,
    retryDelay = 1000;
  let analysisCanvas, signatureCanvas, lastReadFrame;
  let recent = [],
    archived = 0,
    batchBusy = false,
    flushing = null,
    saveError = null;
  const completions = new Set();
  const metadata = () => ({
    attempt,
    lastOracle: sequence?.current(),
    archived,
  });
  const el = (id) => dialog.querySelector(`#${id}`);
  const status = (text) => {
    if (dialog.open && el("scan-status").textContent !== text)
      el("scan-status").textContent = text;
  };
  function prepareRecognition() {
    const geometryReady = presence.prepare();
    void geometryReady.catch(() => {});
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
    Promise.all([geometryReady, recognition.prepare()]).then(
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
    wheel.update([...recent, ...rows], newest);
    wheel.setBusy?.(batchBusy || Boolean(saveError));
    el("photo").disabled = batchBusy || Boolean(saveError);
    el("scan-count").textContent =
      `${rows.length} queued · ${rows.reduce((n, r) => n + r.quantity, 0)} copies`;
    el("scan-empty").hidden = rows.length + recent.length > 0;
    el("scan-review").disabled = rows.length === 0 && archived === 0;
    const saved = el("scan-saved");
    if (saved) saved.hidden = !archived;
    if (saved)
      saved.textContent = archived
        ? `${archived} earlier captures saved · Review opens batches`
        : "";
    const task = Promise.resolve().then(() => onRows(rows, metadata()));
    return task.then(
      () => true,
      (error) => {
        saveError = error;
        wheel.setBusy?.(true);
        el("photo").disabled = true;
        status(`Saving paused: ${error.message} Use Retry saving.`);
        const retry = el("scan-save-retry");
        if (retry) retry.hidden = false;
        overlay?.pause?.();
        return false;
      },
    );
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
  function stop({ preservePresence = false } = {}) {
    session++;
    requestController.abort();
    requestController = new AbortController();
    if (!preservePresence) presence.dispose();
    presenceTask = null;
    overlay?.clear();
    overlay?.pause?.();
    if (!preservePresence) recognition?.dispose?.();
    running = false;
    dialog.dataset.running = "false";
    processing = false;
    clearTimeout(timer);
    stopCamera(stream);
    stream = undefined;
    const video = el("camera-video");
    if (video) video.srcObject = null;
    queue = [];
    void audio?.close();
    if (el("camera-start")) {
      el("camera-start").hidden = false;
      el("camera-start").disabled = false;
    }
  }
  async function leave() {
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
    if (flushing) await flushing.catch(() => {});
    if (rows.length || archived) onReview(rows, metadata());
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
    if (batchBusy || saveError) return;
    if (rows.length >= 50) {
      void flushBatch();
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
      status("Scanning is busy. Hold the next card until reading finishes.");
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
          attempt: ((row.scanId - 1) % 99999) + 1,
          onStage: (stage) => {
            if (current === session && dialog.open)
              overlay?.stage(row.captureId, stage);
          },
          onUpdate: (verified) => {
            if (current !== session || !dialog.open || !verified.selected)
              return;
            verified = { ...verified };
            delete verified.completion;
            if (row.processing) {
              row.latestRecognition = verified;
              return;
            }
            if (!rows.includes(row)) return;
            const chosen = row.selected,
              quantity = row.quantity;
            const edited =
              row.userEdited ||
              verified.selected.oracle_id !== row.acceptedIdentity
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
        if (result?.completion) {
          const pending = Promise.resolve(result.completion).catch(() => {});
          completions.add(pending);
          void pending.then(() => completions.delete(pending));
          result = { ...result };
          delete result.completion;
        }
        if (current === session && dialog.open && el("scan-preparation"))
          el("scan-preparation").textContent = "Scanner ready.";
      } catch (error) {
        failure = { name: error.name, status: error.status || null };
        result = {
          name: "Unclear reading",
          error:
            error.code === "SCANNER_PREPARING"
              ? "Scanner is still preparing. Wait for Ready and keep one card still."
              : "Recognition failed. Keep one card still to retry.",
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
      const acceptance = sequence.accept(row.selected);
      const accepted = acceptance === "accepted";
      const duplicate = acceptance === "duplicate";
      if (accepted) {
        row.acceptedIdentity = row.selected.oracle_id;
        rows.push(row);
        overlay?.recognized(row.captureId, row.name);
      }

      if (!duplicate && !row.waitingForSingleCard)
        audio.cue(accepted ? "success" : "error", row.scanId);
      if (!duplicate) await update(accepted);
      retryDelay = accepted ? 1000 : Math.min(3000, retryDelay + 500);
      status(
        duplicate
          ? "Same card ignored. Slide in a different card, or use + for another copy."
          : row.waitingForSingleCard
            ? "Wait until only one card is visible."
            : accepted
              ? `${row.name} queued · check suggested printing in Review. ${running ? "Slide in the next card." : "Upload another photo or start the camera."}`
              : row.candidates?.length
                ? "Identity uncertain. Keep one card still to retry. No copy counted."
                : `${row.error || "No match. Keep one card still to retry."} No copy counted.`,
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
              : duplicate
                ? "duplicate"
                : accepted
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
    if (current === session) {
      processing = false;
      nextReadingAt = performance.now() + retryDelay;
      if (rows.length >= 50) void flushBatch();
    }
  }
  async function flushBatch() {
    if (flushing) return flushing;
    batchBusy = true;
    overlay?.pause?.();
    wheel.setBusy?.(true);
    el("photo").disabled = true;
    status("Saving this batch. Scanning continues automatically when saved.");
    flushing = (async () => {
      await Promise.allSettled([...completions]);
      if (!onBatch) throw Error("Batch storage is unavailable.");
      const saved = await onBatch(rows, metadata());
      recent =
        saved.recent ||
        rows.slice(-10).map((row) => ({ ...row, archived: true }));
      archived = saved.archived ?? archived + rows.length;
      rows = [];
      saveError = null;
      const durable = await update();
      if (!durable) return;
      if (dialog.open) {
        el("scan-save-retry").hidden = true;
        status("Batch saved. Keep scanning, or open Review.");
        if (running) overlay?.resume?.();
      }
    })()
      .catch((error) => {
        saveError = error;
        status(`Batch not confirmed: ${error.message} Use Retry saving.`);
        if (dialog.open) el("scan-save-retry").hidden = false;
        recognition?.dispose?.();
        presence.dispose();
      })
      .finally(() => {
        batchBusy = false;
        flushing = null;
        wheel.setBusy?.(Boolean(saveError));
        if (dialog.open) el("photo").disabled = Boolean(saveError);
      });
    return flushing;
  }
  function tick(current) {
    if (!running || current !== session) return;
    const began = performance.now();
    try {
      const video = el("camera-video");
      if (video.readyState >= 2 && !batchBusy && !saveError) {
        const low = capture(video, el("scan-guide"), {
          canvas: analysisCanvas,
          maxPixels: 384000,
        });
        const frame = signature(low, null, signatureCanvas),
          now = performance.now();
        gate.track(frame, now);
        overlay?.track(frame);
        // Motion only shortens a retry delay. Periodic reads never require it.
        if (lastReadFrame && visualDifference(frame, lastReadFrame) > 5) {
          nextReadingAt = Math.min(nextReadingAt, now);
          retryDelay = 1000;
        }
        if (
          !processing &&
          !queue.length &&
          !presenceTask &&
          now >= nextReadingAt &&
          now >= nextGeometryAt
        ) {
          const sampled = frame,
            capturedAt = now;
          nextGeometryAt = now + 350;
          const task = presence.inspect(low, {
            signal: AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(35000),
            ]),
          });
          presenceTask = task;
          task
            .then(
              (geometry) => {
                if (current !== session || !running || !dialog.open) return;
                window.dispatchEvent(
                  new CustomEvent("keeper-card-geometry-measurement", {
                    detail: {
                      state: geometry.state,
                      capturedAt,
                      workerMs: geometry.elapsedMs,
                      frameAgeMs: performance.now() - capturedAt,
                      sameScene: gate.matches(sampled, capturedAt),
                    },
                  }),
                );
                if (!gate.matches(sampled, capturedAt)) return;
                overlay?.observe(geometry, sampled);
                if (geometry.state !== "single") {
                  status(
                    geometry.state === "none"
                      ? "Place one card inside the guide."
                      : "Wait until only one card is visible.",
                  );
                } else if (
                  [
                    "Place one card inside the guide.",
                    "Wait until only one card is visible.",
                  ].includes(el("scan-status").textContent)
                )
                  status("Hold still.");
                if (
                  processing ||
                  queue.length ||
                  batchBusy ||
                  saveError ||
                  !gate.validate(sampled, capturedAt, geometry.state)
                )
                  return;
                // Full resolution is copied only for a due, stable single-card read.
                const image = capture(video, el("scan-guide"));
                const fresh = signature(image, null, signatureCanvas);
                if (!gate.matches(fresh, performance.now())) return;
                image.cardGeometry = geometry;
                lastReadFrame = fresh;
                enqueue(image);
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
        Math.max(0, 120 - (performance.now() - began)),
      );
  }
  async function start() {
    stop({ preservePresence: true });
    prepareRecognition();
    update();
    const current = session;
    gate ||= createScanAdmission();
    analysisCanvas = document.createElement("canvas");
    signatureCanvas = document.createElement("canvas");
    lastReadFrame = null;
    nextGeometryAt = 0;
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
      overlay?.resume?.();
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
    open(resume = {}) {
      gate = createScanAdmission();
      sequence = createScanSequence(resume.lastOracle);
      nextReadingAt = 0;
      rows = resume.rows || [];
      recent = resume.recent || [];
      archived = resume.archived || 0;
      queue = [];
      attempt = resume.attempt || 0;
      saveError = null;
      batchBusy = false;
      retryDelay = 1000;
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
        onRemove: (row) => {
          const index = rows.indexOf(row);
          if (index >= 0) rows.splice(index, 1);
        },
      });
      overlay?.pause?.();
      el("scan-save-retry").onclick = async () => {
        saveError = null;
        if (rows.length >= 50 || resume.outgoing) await flushBatch();
        else if (await update()) {
          el("scan-save-retry").hidden = true;
          if (running) overlay?.resume?.();
        }
        if (!saveError) prepareRecognition();
      };
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
        if (batchBusy || saveError) {
          event.target.value = "";
          status(
            "Saving is paused. Retry saving before uploading another photo.",
          );
          return;
        }
        stop({ preservePresence: true });
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
              AbortSignal.timeout(35000),
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
      update(true);
    },
  };
}
