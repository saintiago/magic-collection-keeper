import { visualDifference } from "./scan-transition.js";

// Detector coordinates refer to the clipped source crop, not the CSS guide.
export function overlayPoint(point, video, guide, surface, width, height) {
  const scale = Math.max(video.width / width, video.height / height);
  const offsetX = (width * scale - video.width) / 2,
    offsetY = (height * scale - video.height) / 2;
  const rawX = (guide.left - video.left + offsetX) / scale,
    rawY = (guide.top - video.top + offsetY) / scale;
  const x = Math.max(0, rawX),
    y = Math.max(0, rawY);
  const w = Math.min(width, rawX + guide.width / scale) - x,
    h = Math.min(height, rawY + guide.height / scale) - y;
  return [
    video.left - surface.left + (x + point[0] * w) * scale - offsetX,
    video.top - surface.top + (y + point[1] * h) * scale - offsetY,
  ];
}

export function createScanOverlay({ canvas, video, guide }) {
  const context = canvas.getContext("2d"),
    reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let geometry = null,
    anchor = null,
    captureId = null,
    identity = "",
    until = 0,
    frame = 0,
    stopped = false;
  const stages = new Set(),
    metrics = { frames: 0, totalDrawMs: 0, maxDrawMs: 0 };
  function resetCapture() {
    captureId = null;
    identity = "";
    stages.clear();
  }
  function requestDraw() {
    if (!stopped && !frame) frame = requestAnimationFrame(draw);
  }
  const resized = new ResizeObserver(requestDraw);
  resized.observe(canvas);
  function draw(now) {
    frame = 0;
    if (stopped) return;
    const began = performance.now(),
      bounds = canvas.getBoundingClientRect(),
      ratio = Math.min(2, devicePixelRatio || 1);
    if (
      canvas.width !== Math.round(bounds.width * ratio) ||
      canvas.height !== Math.round(bounds.height * ratio)
    ) {
      canvas.width = Math.round(bounds.width * ratio);
      canvas.height = Math.round(bounds.height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    if (geometry && video.videoWidth && video.videoHeight && bounds.width) {
      const videoBounds = video.getBoundingClientRect(),
        guideBounds = guide.getBoundingClientRect();
      const project = (point) =>
        overlayPoint(
          point,
          videoBounds,
          guideBounds,
          bounds,
          video.videoWidth,
          video.videoHeight,
        );
      if (identity && now > until) identity = "";
      const accepted = Boolean(identity),
        waiting = geometry.state !== "single",
        active = stages.size > 0;
      context.strokeStyle = accepted
        ? "#92edb8"
        : waiting
          ? "#ffd78a"
          : "#a7dce4";
      context.lineWidth = accepted ? 3 : 2;
      context.globalAlpha =
        active && !reduced.matches ? 0.7 + 0.2 * Math.sin(now / 180) : 0.9;
      for (const polygon of geometry.regions || []) {
        context.beginPath();
        polygon.forEach((p, i) => {
          const [x, y] = project(p);
          if (i) context.lineTo(x, y);
          else context.moveTo(x, y);
        });
        context.closePath();
        context.stroke();
      }
      // Only a real OCR stage may draw the title activity box. Remote HTTP does
      // not expose its internal phases, so it uses general service activity.
      if (stages.has("ocr-title") && geometry.regions?.[0]) {
        const p = geometry.regions[0],
          mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
        const band = [
          mix(p[0], p[3], 0.02),
          mix(p[1], p[2], 0.02),
          mix(p[1], p[2], 0.12),
          mix(p[0], p[3], 0.12),
        ];
        context.setLineDash(reduced.matches ? [] : [5, 4]);
        context.beginPath();
        band.forEach((p, i) => {
          const [x, y] = project(p);
          if (i) context.lineTo(x, y);
          else context.moveTo(x, y);
        });
        context.closePath();
        context.stroke();
        context.setLineDash([]);
      }
      const label = accepted
        ? `${identity} · review printing`
        : geometry.state === "multiple" || geometry.state === "ambiguous"
          ? "One card at a time"
          : active
            ? stages.has("visual")
              ? "Matching artwork"
              : "Reading card"
            : "Hold still";
      if (geometry.regions?.length) {
        const x = Math.max(12, guideBounds.left - bounds.left),
          y = Math.min(
            bounds.height - 70,
            guideBounds.bottom - bounds.top + 24,
          );
        context.globalAlpha = 1;
        context.font = "13px system-ui";
        context.fillStyle = "rgba(15,30,29,.82)";
        const max = Math.max(
          10,
          Math.min(guideBounds.width, bounds.width - x - 12),
        );
        context.fillRect(x - 5, y - 17, max + 10, 25);
        context.fillStyle = "#fff";
        context.fillText(label, x, y, max);
      }
    }
    const elapsed = performance.now() - began;
    metrics.frames++;
    metrics.totalDrawMs += elapsed;
    metrics.maxDrawMs = Math.max(metrics.maxDrawMs, elapsed);
    if (stages.size || (identity && now < until)) requestDraw();
  }
  requestDraw();
  return {
    resume() {
      if (stopped) {
        stopped = false;
        frame = requestAnimationFrame(draw);
      }
    },
    pause() {
      stopped = true;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    track(signature) {
      if (anchor && visualDifference(anchor, signature) > 16) {
        resetCapture();
        geometry = null;
        anchor = signature;
        requestDraw();
      }
    },
    observe(next, signature) {
      if (
        !anchor ||
        next.state !== "single" ||
        visualDifference(anchor, signature) > 16
      ) {
        resetCapture();
        anchor = signature;
      }
      geometry = next;
      requestDraw();
    },
    capture(id, signature, detected) {
      if (
        anchor &&
        visualDifference(anchor, signature) <= 5 &&
        detected?.state === "single"
      ) {
        resetCapture();
        captureId = id;
        geometry = detected;
        requestDraw();
      }
    },
    stage(id, { stage, active }) {
      if (id !== captureId || stopped) return;
      if (active) stages.add(stage);
      else stages.delete(stage);
      requestDraw();
    },
    recognized(id, name) {
      if (id !== captureId || stopped) return;
      identity = String(name).slice(0, 65);
      until = performance.now() + 1400;
      stages.clear();
      requestDraw();
    },
    clear() {
      geometry = null;
      anchor = null;
      resetCapture();
      context.clearRect(0, 0, canvas.width, canvas.height);
      requestDraw();
    },
    destroy() {
      resized.disconnect();
      stopped = true;
      cancelAnimationFrame(frame);
      context.clearRect(0, 0, canvas.width, canvas.height);
      return {
        ...metrics,
        meanDrawMs: metrics.frames ? metrics.totalDrawMs / metrics.frames : 0,
      };
    },
    metrics: () => ({
      ...metrics,
      meanDrawMs: metrics.frames ? metrics.totalDrawMs / metrics.frames : 0,
    }),
  };
}
