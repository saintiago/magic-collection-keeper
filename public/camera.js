export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(
      "Camera access needs HTTPS and a supported browser. You can upload a card photo instead.",
    );
  let abandoned = false,
    timeout,
    stream;
  try {
    const request = navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
      .then((candidate) => {
        if (abandoned) {
          stopCamera(candidate);
          throw new Error("Camera request ended.");
        }
        return candidate;
      });
    stream = await Promise.race([
      request,
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
    video.srcObject = stream;
    await video.play();
    return stream;
  } catch (e) {
    stopCamera(stream);
    throw new Error(
      e.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in your browser, or upload a photo."
        : e.name === "NotFoundError"
          ? "No camera found. Upload a card photo instead."
          : `Camera unavailable: ${e.message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}
export function capture(video) {
  const canvas = document.createElement("canvas");
  // The guide corresponds to the central portrait-shaped area of the video.
  const h = video.videoHeight * 0.88,
    w = Math.min(video.videoWidth * 0.9, (h * 488) / 680);
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
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
      w,
      h,
    );
  return canvas;
}
export function signature(canvas) {
  const small = document.createElement("canvas");
  small.width = 24;
  small.height = 32;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 24, 32);
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
