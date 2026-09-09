// Public artwork in a generated stream, never physical-device verification.
export function installSyntheticCardCamera(imageData) {
  navigator.mediaDevices.getUserMedia = async () => {
    const photo = new Image();
    photo.src = imageData;
    await photo.decode();
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
      ctx.drawImage(photo, x, y, w, h);
    };
    window.paintSyntheticCard();
    window.syntheticStream = canvas.captureStream(15);
    return window.syntheticStream;
  };
}
