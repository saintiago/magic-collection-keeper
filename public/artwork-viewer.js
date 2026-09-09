import { image, esc } from "./view.js";
import { cardHoverInfo } from "./card-tile-view.js";
import { inspectorDetails, inspectorControls } from "./artwork-inspector.js";
import { boundedArtwork } from "./card-action-layout.js";

export function createArtworkViewer({ onDetails, onEdit, onTag, onQuantity }) {
  const dialog = document.createElement("dialog");
  dialog.className = "artwork-viewer";
  document.body.append(dialog);
  const preview = document.createElement("div");
  preview.className = "artwork-hover";
  preview.hidden = true;
  document.body.append(preview);
  let previewSource = null,
    selection = null,
    origin = null,
    originKey = null,
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
    previewSource = null;
    preview.replaceChildren();
  }
  function hover(found, bounds, transform) {
    if (dialog.open || !image(found.item.card)) return;
    const width = Math.min(
        bounds.width * 2,
        innerWidth - 24,
        ((innerHeight - 24) * 488) / 680,
      ),
      height = (width * 680) / 488;
    preview.innerHTML = `<div class="artwork-hover-reveal"><div class="artwork-hover-visual"><img src="${esc(image(found.item.card))}" alt="${esc(found.item.card.name)}">${cardHoverInfo(found.item.row || { card: found.item.card }, null, { pending: found.item.kind === "pending" })}</div></div>`;
    preview.style.cssText = `width:${width}px;height:${height}px;left:${Math.max(12, Math.min(innerWidth - width - 12, bounds.x + (bounds.width - width) / 2))}px;top:${Math.max(12, Math.min(innerHeight - height - 12, bounds.y + (bounds.height - height) / 2))}px`;
    preview.hidden = false;
    previewSource = found;
    setHoverTilt(transform);
    return preview.getBoundingClientRect();
  }
  function setHoverTilt(transform) {
    if (!preview.hidden)
      preview.querySelector(".artwork-hover-visual").style.transform =
        transform;
  }
  function draw() {
    frame = 0;
    if (!dialog.open || !state) return;
    const area = dialog.querySelector(".artwork-viewport");
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
    const focus = origin?.isConnected
      ? origin
      : originKey
        ? document.querySelector(
            `[data-card-key="${CSS.escape(originKey)}"] button`,
          )
        : null;
    focus?.focus({ preventScroll: true });
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
  dialog.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest("a[data-tag-id]");
      if (
        !link ||
        event.button ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const tag = {
        id: link.dataset.tagId,
        label: link.dataset.tagLabel,
        type: link.dataset.tagType,
        kind: link.dataset.tagKind,
      };
      close(() => onTag(tag));
    },
    true,
  );
  dialog.addEventListener("submit", async (event) => {
    if (!event.target.matches(".artwork-quantity")) return;
    event.preventDefault();
    const form = event.target,
      item = selection,
      button = form.querySelector("button"),
      status = form.querySelector('[role="status"]');
    button.disabled = true;
    status.textContent = "Saving…";
    try {
      const row = await onQuantity(item, Number(form.elements.quantity.value));
      if (!form.isConnected || selection !== item || !row) return;
      item.row = row;
      dialog.querySelector(".artwork-details").innerHTML =
        inspectorDetails(item);
      status.textContent = "Quantity saved.";
    } catch (error) {
      if (form.isConnected) status.textContent = error.message;
    } finally {
      if (form.isConnected) button.disabled = false;
    }
  });
  dialog.addEventListener("click", (event) => {
    const action = event.target.closest("[data-artwork]")?.dataset.artwork;
    if (!action) return;
    if (action === "close") return close();
    if (action === "details" || action === "edit") {
      const item = selection,
        element = origin;
      return close(() =>
        action === "details" ? onDetails(item, element) : onEdit(item, element),
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
      outside:
        event.target.classList.contains("artwork-stage") ||
        event.target.classList.contains("artwork-viewport") ||
        event.target.classList.contains("artwork-open-reveal"),
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
    setHoverTilt,
    hoverSource: (target) =>
      !preview.hidden && preview.contains(target) ? previewSource : null,
    hidePreview,
    close,
    get isOpen() {
      return dialog.open;
    },
    open(item, element) {
      const card = item.card,
        src = image(card);
      if (dialog.open) return;
      hidePreview();
      selection = item;
      origin = element;
      originKey = element.closest("[data-card-key]")?.dataset.cardKey || null;
      const bounds = element.getBoundingClientRect();
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
      dialog.innerHTML = `<header><h2>${esc(card.name)}</h2><button data-artwork="close" aria-label="Close artwork">×</button></header><div class="artwork-inspector"><aside class="artwork-details" aria-label="Card information">${inspectorDetails(item)}</aside><div class="artwork-stage"><div class="artwork-viewport"><div class="artwork-open-reveal">${src ? `<img class="artwork-full-image" src="${esc(src)}" alt="${esc(card.name)}" draggable="false" style="width:${state.baseWidth}px;height:${state.baseHeight}px">` : `<div class="artwork-full-image artwork-placeholder" style="width:${state.baseWidth}px;height:${state.baseHeight}px">Artwork unavailable</div>`}</div></div></div><aside class="artwork-controls" aria-label="Card controls">${inspectorControls(item)}</aside></div><footer><button data-artwork="out" aria-label="Zoom out">−</button><output aria-label="Artwork zoom">300%</output><button data-artwork="in" aria-label="Zoom in">+</button><button data-artwork="reset">Reset</button></footer>`;
      dialog.showModal();
      draw();
      dialog.querySelector('[data-artwork="close"]').focus();
    },
  };
}
