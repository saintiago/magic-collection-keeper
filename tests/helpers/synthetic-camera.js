// Generated text target, never a claim of physical-device camera verification.
export function installSyntheticCardCamera() {
  navigator.mediaDevices.getUserMedia = async () => {
    const video = document
      .querySelector("#camera-video")
      .getBoundingClientRect();
    const guide = document.querySelector("#scan-guide").getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.width * 2);
    canvas.height = Math.round(video.height * 2);
    const ctx = canvas.getContext("2d");
    window.paintSyntheticCard = (blank = false) => {
      ctx.fillStyle = "#384c43";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (blank) return;
      const x = (guide.left - video.left) * 2,
        y = (guide.top - video.top) * 2,
        w = guide.width * 2,
        h = guide.height * 2;
      ctx.fillStyle = "white";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#809986";
      ctx.fillRect(x + w * 0.05, y + h * 0.15, w * 0.9, h * 0.42);
      ctx.fillStyle = "black";
      ctx.font = `bold ${w * 0.066}px Arial`;
      ctx.fillText("Lightning Bolt", x + w * 0.05, y + h * 0.09);
      ctx.font = `${w * 0.043}px Arial`;
      ctx.fillText("Instant", x + w * 0.05, y + h * 0.63);
      ctx.fillText("149", x + w * 0.05, y + h * 0.89);
      ctx.fillText("M11 EN", x + w * 0.05, y + h * 0.94);
    };
    window.paintSyntheticCard();
    window.syntheticStream = canvas.captureStream(15);
    return window.syntheticStream;
  };
}
