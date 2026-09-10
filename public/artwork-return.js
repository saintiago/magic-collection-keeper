// One existing lifted image returns to a live source frame. Layout reads run only
// during this bounded transition, so scrolling/replaced tiles cannot leave a
// stale landing position. No clone or continuing idle animation is created.
export function returnArtwork({ dialog, source, zoom, complete }) {
  const layers = [
    dialog.querySelector(".artwork-open-reveal"),
    dialog.querySelector(".artwork-open-orientation"),
    dialog.querySelector(".artwork-full-image"),
  ];
  const starts = layers.map((element) =>
    new DOMMatrix(getComputedStyle(element).transform).toFloat64Array(),
  );
  layers.forEach((element, index) => {
    element.style.animation = "none";
    element.style.transform = `matrix3d(${starts[index].join(",")})`;
  });
  const shade = dialog.animate(
    [
      { backgroundColor: getComputedStyle(dialog).backgroundColor },
      { backgroundColor: "transparent" },
    ],
    { duration: 380, fill: "forwards" },
  );
  const controls = [...dialog.querySelectorAll("aside")].map((element) =>
    element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 140,
      fill: "forwards",
    }),
  );
  const started = performance.now();
  let frame = 0,
    previous = started,
    elapsed = 0,
    stopped = false,
    landed = false,
    missingAt = null;
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    shade.cancel();
    controls.forEach((animation) => animation.cancel());
  }
  function draw(now) {
    if (stopped) return;
    // A delayed paint must not spend the whole visible shrink offscreen. Keep
    // at most two nominal frames of progress per paint, with a wall-time bound
    // for a severely stalled browser. Normal refresh still takes 380ms.
    elapsed += Math.min(32, Math.max(0, now - previous));
    previous = now;
    const destination = source();
    if (!destination) {
      // Navigation/removal has no honest return target. Fade the current image
      // briefly, without inventing a tile or retaining a hidden source.
      missingAt ??= now;
      layers[0].style.opacity = String(
        Math.max(0, 1 - (now - missingAt) / 120),
      );
      if (now - missingAt >= 120) return complete();
    } else {
      missingAt = null;
      layers[0].style.opacity = "1";
      const t = now - started >= 1200 ? 1 : Math.min(1, elapsed / 380);
      const spring = (time) =>
        1 -
        Math.exp(-8 * time) *
          (Math.cos(7 * time) + (8 / 7) * Math.sin(7 * time));
      const progress = t === 1 ? 1 : spring(t) / spring(1);
      const viewport = layers[0].parentElement.getBoundingClientRect();
      const centerX =
        viewport.left + layers[0].offsetLeft + layers[0].offsetWidth / 2;
      const centerY =
        viewport.top + layers[0].offsetTop + layers[0].offsetHeight / 2;
      const targets = [
        new DOMMatrix()
          .translate(
            destination.x + destination.width / 2 - centerX,
            destination.y + destination.height / 2 - centerY,
          )
          .scale(
            destination.width / layers[0].offsetWidth,
            destination.height / layers[0].offsetHeight,
          ),
        new DOMMatrix(),
        new DOMMatrix().scale(zoom),
      ];
      layers.forEach((element, index) => {
        const end = targets[index].toFloat64Array();
        element.style.transform = `matrix3d(${starts[index].map((value, i) => value + (end[i] - value) * progress).join(",")})`;
      });
      // Paint the exact landing frame before revealing the original DOM image.
      if (t === 1 && landed) return complete();
      landed = t === 1;
    }
    frame = requestAnimationFrame(draw);
  }
  frame = requestAnimationFrame(draw);
  return stop;
}
