import { image, esc } from "./view.js";
import { boundedArtwork } from "./card-action-layout.js";

export function createArtworkViewer({ onDetails, onActions }) {
  const dialog = document.createElement("dialog");
  dialog.className = "artwork-viewer";
  document.body.append(dialog);
  const preview = document.createElement("div");
  preview.className = "artwork-hover";
  preview.hidden = true;
  document.body.append(preview);
  let selection = null,
    origin = null,
    historyKey = null,
    afterClose = null,
    frame = 0,
    points = new Map(),
    gesture = null,
    state = null,
    rect = null,
    suppressUntil = 0;

  function hidePreview() {
    preview.hidden = true;
    preview.replaceChildren();
  }
  function hover(card, element) {
    if (dialog.open || !image(card)) return;
    const bounds = element.getBoundingClientRect(),
      width = bounds.width * 2,
      height = (width * 680) / 488;
    preview.innerHTML = `<img src="${esc(image(card))}" alt="">`;
    preview.style.cssText = `width:${width}px;height:${height}px;left:${Math.max(8, Math.min(innerWidth - width - 8, bounds.x + (bounds.width - width) / 2))}px;top:${Math.max(8, Math.min(innerHeight - height - 8, bounds.y + (bounds.height - height) / 2))}px`;
    preview.hidden = false;
  }
  function draw() {
    frame = 0;
    if (!dialog.open || !state) return;
    const area = dialog.querySelector(".artwork-stage");
    rect = area.getBoundingClientRect();
    state = {
      ...state,
      ...boundedArtwork({ ...state, width: rect.width, height: rect.height }),
    };
    dialog.querySelector(".artwork-full-image").style.transform =
      `translate(${state.x}px,${state.y}px) scale(${state.zoom})`;
    dialog.querySelector("output").value = `${Math.round(state.zoom * 100)}%`;
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function finish() {
    cancelAnimationFrame(frame);
    frame = 0;
    points.clear();
    gesture = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    selection = null;
    historyKey = null;
    origin?.isConnected && origin.focus({ preventScroll: true });
    const next = afterClose;
    afterClose = null;
    next?.();
  }
  function close(next) {
    if (!dialog.open) return;
    afterClose = next || null;
    if (history.state?.keeperArtwork === historyKey) history.back();
    else finish();
  }
  window.addEventListener("popstate", () => {
    if (dialog.open && history.state?.keeperArtwork !== historyKey) finish();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    const action = event.target.closest("[data-artwork]")?.dataset.artwork;
    if (!action) return;
    if (action === "close") return close();
    if (action === "details" || action === "actions") {
      const item = selection,
        element = origin;
      return close(() =>
        action === "details"
          ? onDetails(item, element)
          : onActions(item, element),
      );
    }
    if (action === "in") state.zoom *= 1.25;
    if (action === "out") state.zoom /= 1.25;
    if (action === "reset") {
      state.zoom = 3;
      state.x = state.y = 0;
    }
    schedule();
  });
  dialog.addEventListener(
    "wheel",
    (event) => {
      if (!event.target.closest(".artwork-stage")) return;
      event.preventDefault();
      state.zoom *= Math.exp(-event.deltaY * 0.0015);
      schedule();
    },
    { passive: false },
  );
  dialog.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".artwork-stage")) return;
    event.preventDefault();
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      dialog.setPointerCapture(event.pointerId);
    } catch {
      /* A canceled pointer can already have ended. */
    }
    const all = [...points.values()];
    gesture = {
      start: { x: event.clientX, y: event.clientY },
      x: state.x,
      y: state.y,
      zoom: state.zoom,
      outside: event.target.classList.contains("artwork-stage"),
      distance:
        all.length === 2
          ? Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y)
          : 0,
      midpoint:
        all.length === 2
          ? { x: (all[0].x + all[1].x) / 2, y: (all[0].y + all[1].y) / 2 }
          : null,
    };
  });
  dialog.addEventListener("pointermove", (event) => {
    if (!state || !rect) return;
    if (points.has(event.pointerId)) {
      event.preventDefault();
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const all = [...points.values()];
      if (all.length === 2 && gesture.distance) {
        state.zoom =
          (gesture.zoom *
            Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y)) /
          gesture.distance;
        state.x = gesture.x + (all[0].x + all[1].x) / 2 - gesture.midpoint.x;
        state.y = gesture.y + (all[0].y + all[1].y) / 2 - gesture.midpoint.y;
      } else {
        state.x = gesture.x + event.clientX - gesture.start.x;
        state.y = gesture.y + event.clientY - gesture.start.y;
      }
      schedule();
    } else if (
      event.pointerType === "mouse" &&
      event.target.closest(".artwork-stage")
    ) {
      state.x =
        (1 - (2 * (event.clientX - rect.left)) / rect.width) * state.limitX;
      state.y =
        (1 - (2 * (event.clientY - rect.top)) / rect.height) * state.limitY;
      schedule();
    }
  });
  const up = (event) => {
    if (!points.has(event.pointerId)) return;
    const outside =
      gesture?.outside &&
      points.size === 1 &&
      Math.hypot(
        event.clientX - gesture.start.x,
        event.clientY - gesture.start.y,
      ) < 8;
    points.delete(event.pointerId);
    if (!points.size) gesture = null;
    else if (points.size === 1)
      gesture = {
        start: [...points.values()][0],
        x: state.x,
        y: state.y,
        zoom: state.zoom,
        outside: false,
        distance: 0,
      };
    if (outside && event.type !== "pointercancel") {
      event.preventDefault();
      event.stopPropagation();
      suppressUntil = performance.now() + 400;
      close();
    }
  };
  dialog.addEventListener("pointerup", up);
  dialog.addEventListener("pointercancel", up);
  document.addEventListener(
    "pointerdown",
    () => {
      suppressUntil = 0;
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (performance.now() < suppressUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressUntil = 0;
      }
    },
    true,
  );
  window.addEventListener("resize", () => {
    hidePreview();
    if (dialog.open) schedule();
  });
  window.addEventListener("pagehide", () => {
    hidePreview();
    afterClose = null;
    finish();
  });
  window.addEventListener("keeper-sign-out", () => {
    hidePreview();
    afterClose = null;
    finish();
  });
  return {
    hover,
    hidePreview,
    close,
    get isOpen() {
      return dialog.open;
    },
    open(item, element) {
      const card = item.card,
        src = image(card);
      if (!src || dialog.open) return;
      hidePreview();
      selection = item;
      origin = element;
      const bounds =
        element.querySelector("img")?.getBoundingClientRect() ||
        element.getBoundingClientRect();
      state = {
        baseWidth: Math.max(80, bounds.width),
        baseHeight: (Math.max(80, bounds.width) * 680) / 488,
        zoom: 3,
        x: 0,
        y: 0,
      };
      historyKey = crypto.randomUUID();
      history.pushState(
        { ...history.state, keeperArtwork: historyKey },
        "",
        location.href,
      );
      dialog.innerHTML = `<header><h2>${esc(card.name)}</h2><button data-artwork="close" aria-label="Close artwork">×</button></header><div class="artwork-stage"><img class="artwork-full-image" src="${esc(src)}" alt="${esc(card.name)}" draggable="false" style="width:${state.baseWidth}px;height:${state.baseHeight}px"></div><footer><button data-artwork="out" aria-label="Zoom out">−</button><output aria-label="Artwork zoom">300%</output><button data-artwork="in" aria-label="Zoom in">+</button><button data-artwork="reset">Reset</button><button data-artwork="details">Card details</button><button data-artwork="actions">Card actions</button></footer>`;
      dialog.showModal();
      draw();
      dialog.querySelector('[data-artwork="close"]').focus();
    },
  };
}
