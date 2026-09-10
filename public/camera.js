const requested = {
  facingMode: { ideal: "environment" },
  width: { ideal: 2560 },
  height: { ideal: 1440 },
};

export function cameraDiagnostics(track, applied = []) {
  let settings = {};
  try {
    settings = track?.getSettings?.() || {};
  } catch {
    /* Optional API. */
  }
  const actual = {};
  for (const key of ["width", "height", "frameRate", "aspectRatio", "zoom"])
    if (Number.isFinite(settings[key])) actual[key] = settings[key];
  for (const key of [
    "facingMode",
    "focusMode",
    "exposureMode",
    "whiteBalanceMode",
  ])
    if (
      [
        "user",
        "environment",
        "left",
        "right",
        "none",
        "manual",
        "single-shot",
        "continuous",
      ].includes(settings[key])
    )
      actual[key] = settings[key];
  return {
    requested: { width: 2560, height: 1440, facingMode: "environment" },
    actual,
    requestedControls: applied,
    imageCaptureAvailable: typeof globalThis.ImageCapture === "function",
  };
}

export async function improveCamera(track, signal) {
  const applied = [];
  if (!track?.getCapabilities || !track?.applyConstraints) return applied;
  let caps, original;
  try {
    caps = track.getCapabilities();
    original = track.getConstraints?.() || {};
  } catch {
    return applied;
  }
  const options = [];
  for (const key of ["focusMode", "exposureMode", "whiteBalanceMode"])
    if (caps[key]?.includes?.("continuous"))
      options.push({ [key]: "continuous" });
  if (
    navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest &&
    caps.focusMode?.includes?.("continuous")
  )
    options.push({ pointsOfInterest: [{ x: 0.5, y: 0.5 }] });
  for (const option of options) {
    signal?.throwIfAborted();
    let timer;
    try {
      const completed = await Promise.race([
        track
          .applyConstraints({
            ...original,
            advanced: [
              ...(original.advanced || []),
              ...applied.map((key) => options.find((o) => key in o)),
              option,
            ],
          })
          .then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 500);
        }),
      ]);
      if (!completed) break;
      signal?.throwIfAborted();
      applied.push(Object.keys(option)[0]);
    } catch (error) {
      signal?.throwIfAborted();
      // Optional controls, including OverconstrainedError, retain usable video.
    } finally {
      clearTimeout(timer);
    }
  }
  return applied;
}

export async function startCamera(
  video,
  { signal, onDiagnostics = () => {} } = {},
) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Camera access needs HTTPS and a supported browser. You can upload a card photo instead.",
    );
  let abandoned = false,
    timeout,
    stream,
    abort;
  signal?.throwIfAborted();
  try {
    const request = navigator.mediaDevices
      .getUserMedia({
        video: requested,
        audio: false,
      })
      .catch((error) => {
        if (
          error.name !== "OverconstrainedError" ||
          abandoned ||
          signal?.aborted
        )
          throw error;
        return navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      })
      .then((candidate) => {
        if (abandoned) {
          stopCamera(candidate);
          throw new Error("Camera request ended.");
        }
        return candidate;
      })
      .then(async (candidate) => {
        stream = candidate;
        const applied = await improveCamera(
          candidate.getVideoTracks?.()[0],
          signal,
        );
        if (abandoned || signal?.aborted) {
          stopCamera(candidate);
          throw new Error("Camera request ended.");
        }
        video.srcObject = candidate;
        await video.play();
        if (abandoned || signal?.aborted) {
          stopCamera(candidate);
          throw new Error("Camera request ended.");
        }
        onDiagnostics(
          cameraDiagnostics(candidate.getVideoTracks?.()[0], applied),
        );
        return candidate;
      });
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        abort = () => {
          abandoned = true;
          stopCamera(stream);
          reject(new DOMException("Camera request ended.", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          abandoned = true;
          reject(
            new Error(
              "Permission request timed out. Try a regular browser or upload a photo.",
            ),
          );
        }, 15000);
      }),
    ]);
  } catch (e) {
    stopCamera(stream);
    if (video.srcObject === stream) video.srcObject = null;
    if (e.name === "AbortError") throw e;
    throw new Error(
      e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in your browser, or upload a photo."
        : e.name === "NotFoundError"
          ? "No camera found. Upload a card photo instead."
          : `Camera unavailable: ${e.message}`,
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
export function capture(video, guide) {
  if (!(video.videoWidth > 0 && video.videoHeight > 0))
    throw new Error("Camera is not ready.");
  const canvas = document.createElement("canvas");
  if (guide) {
    const bounds = video.getBoundingClientRect(),
      box = guide.getBoundingClientRect();
    const scale = Math.max(
      bounds.width / video.videoWidth,
      bounds.height / video.videoHeight,
    );
    const rawX =
      (box.left - bounds.left + (video.videoWidth * scale - bounds.width) / 2) /
      scale;
    const rawY =
      (box.top - bounds.top + (video.videoHeight * scale - bounds.height) / 2) /
      scale;
    const x = Math.max(0, rawX),
      y = Math.max(0, rawY);
    const width = Math.min(video.videoWidth, rawX + box.width / scale) - x,
      height = Math.min(video.videoHeight, rawY + box.height / scale) - y;
    if (!(width > 0 && height > 0))
      throw new Error("Camera guide is outside the video.");
    const bounded = Math.min(1, Math.sqrt(4000000 / (width * height)));
    canvas.width = Math.max(1, Math.floor(width * bounded));
    canvas.height = Math.max(1, Math.floor(height * bounded));
    canvas
      .getContext("2d")
      .drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  // The guide corresponds to the central portrait-shaped area of the video.
  const h = video.videoHeight * 0.88,
    w = Math.min(video.videoWidth * 0.9, (h * 488) / 680);
  const bounded = Math.min(1, Math.sqrt(4000000 / (w * h)));
  canvas.width = Math.max(1, Math.floor(w * bounded));
  canvas.height = Math.max(1, Math.floor(h * bounded));
  canvas
    .getContext("2d")
    .drawImage(
      video,
      (video.videoWidth - w) / 2,
      (video.videoHeight - h) / 2,
      w,
      h,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  return canvas;
}
export function signature(canvas, corners) {
  const small = document.createElement("canvas");
  small.width = 24;
  small.height = 32;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (corners?.length === 4) {
    const xs = corners.map(([x]) => x * canvas.width);
    const ys = corners.map(([, y]) => y * canvas.height);
    const x = Math.max(0, Math.min(...xs)),
      y = Math.max(0, Math.min(...ys));
    ctx.drawImage(
      canvas,
      x,
      y,
      Math.min(canvas.width, Math.max(...xs)) - x,
      Math.min(canvas.height, Math.max(...ys)) - y,
      0,
      0,
      24,
      32,
    );
  } else ctx.drawImage(canvas, 0, 0, 24, 32);
  return ctx.getImageData(0, 0, 24, 32).data;
}
export function frameDifference(a, b) {
  if (!a || !b) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4)
    sum +=
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
  return sum / ((a.length / 4) * 3);
}
