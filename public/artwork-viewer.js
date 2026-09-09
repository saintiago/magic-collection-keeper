import { image, esc } from "./view.js";
import { cardHoverInfo } from "./card-tile-view.js";
import { inspectorDetails, inspectorView } from "./artwork-inspector.js";
import {
  artworkOpening,
  boundedArtwork,
  enlargedArtwork,
} from "./card-action-layout.js";
import { upgradeArtwork } from "./artwork-images.js";
import { returnArtwork } from "./artwork-return.js";

export function createArtworkViewer({ onDetails, onEdit, onTag, onQuantity }) {
  const dialog = document.createElement("dialog");
  dialog.className = "artwork-viewer";
  dialog.tabIndex = -1;
  dialog.autofocus = true;
  dialog.setAttribute("aria-label", "Card artwork and information");
  document.body.append(dialog);
  const preview = document.createElement("div");
  preview.className = "artwork-hover";
  preview.hidden = true;
  document.body.append(preview);
  let previewSource = null,
    previewVisual = null,
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
    suppressUntil = 0,
    glass = null,
    closing = false,
    returningSource = null,
    stopReturn = null;

  function hidePreview() {
    if (preview.hidden) return;
    previewSource?.element.classList.remove("artwork-source-lifted");
    preview.hidden = true;
    previewSource = null;
    previewVisual = null;
    preview.replaceChildren();
  }
  function hover(found, bounds, transform) {
    if (dialog.open || !image(found.item.card)) return;
    const { width, height, x, y } = enlargedArtwork(bounds, 2, {
      width: innerWidth,
      height: innerHeight,
    });
    preview.innerHTML = `<div class="artwork-hover-reveal"><div class="artwork-hover-visual"><img src="${esc(image(found.item.card))}" alt="${esc(found.item.card.name)}">${cardHoverInfo(found.item.row || { card: found.item.card }, null, { pending: found.item.kind === "pending" })}</div></div>`;
    preview.style.cssText = `width:${width}px;height:${height}px;left:${x}px;top:${y}px`;
    preview.style.setProperty(
      "--artwork-lift-x",
      bounds.x + bounds.width / 2 - x - width / 2 + "px",
    );
    preview.style.setProperty(
      "--artwork-lift-y",
      bounds.y + bounds.height / 2 - y - height / 2 + "px",
    );
    preview.style.setProperty(
      "--artwork-lift-scale",
      String(bounds.width / width),
    );
    preview.hidden = false;
    found.element.classList.add("artwork-source-lifted");
    previewSource = found;
    previewVisual = preview.querySelector(".artwork-hover-visual");
    upgradeArtwork(previewVisual.querySelector("img"), found.item.card);
    setHoverTilt(transform);
    return { x, y, width, height };
  }
  function setHoverTilt(transform) {
    if (previewVisual) previewVisual.style.transform = transform;
  }
  function draw() {
    frame = 0;
    if (!dialog.open || !state || closing) return;
    if (glass?.dirty) {
      glass.element.style.setProperty("--glass-x", glass.x + "%");
      glass.element.style.setProperty("--glass-y", glass.y + "%");
      glass.dirty = false;
    }
    if (!rect)
      rect = dialog.querySelector(".artwork-viewport").getBoundingClientRect();
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
    stopReturn?.();
    stopReturn = null;
    closing = false;
    delete dialog.dataset.closing;
    cancelAnimationFrame(frame);
    frame = 0;
    points.clear();
    gesture = null;
    glass = null;
    origin?.classList.remove("artwork-source-lifted");
    returningSource?.classList.remove("artwork-source-lifted");
    returningSource = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    rect = null;
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
  function sourceElement() {
    return origin?.isConnected
      ? origin
      : originKey
        ? document.querySelector(
            `[data-card-key="${CSS.escape(originKey)}"] button`,
          )
        : null;
  }
  function animateClose() {
    if (!dialog.open || stopReturn) return;
    closing = true;
    cancelAnimationFrame(frame);
    frame = 0;
    points.clear();
    gesture = null;
    dialog.dataset.closing = "";
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
    stopReturn = returnArtwork({
      dialog,
      zoom: state.initialZoom,
      source: () => {
        const target = sourceElement();
        if (returningSource !== target) {
          returningSource?.classList.remove("artwork-source-lifted");
          returningSource = target;
          returningSource?.classList.add("artwork-source-lifted");
        }
        const bounds = target?.getBoundingClientRect();
        return bounds?.width && bounds?.height ? bounds : null;
      },
      complete: finish,
    });
  }
  function close(next) {
    if (!dialog.open || closing) return;
    closing = true;
    afterClose = next || null;
    if (history.state?.keeperArtwork === historyKey) history.back();
    else animateClose();
  }
  window.addEventListener("popstate", () => {
    if (dialog.open && history.state?.keeperArtwork !== historyKey)
      animateClose();
  });
  for (const type of ["click", "pointerdown", "wheel", "submit"])
    dialog.addEventListener(
      type,
      (event) => {
        if (!closing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, passive: false },
    );
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
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
      resize();
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
      state.zoom = state.initialZoom;
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
    if (!event.target.closest(".artwork-stage") && event.target !== dialog)
      return;
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
        event.target === dialog ||
        event.target.classList.contains("artwork-stage") ||
        event.target.classList.contains("artwork-viewport") ||
        event.target.classList.contains("artwork-open-orientation") ||
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
  const glassSelector =
    '.artwork-controls > button:not([data-artwork="close"]), .artwork-quantity, .artwork-zoom';
  dialog.addEventListener("pointerover", (event) => {
    const surface = event.target.closest(glassSelector);
    if (glass?.element === surface) return;
    glass?.element.removeAttribute("data-lit");
    glass = surface
      ? { element: surface, bounds: surface.getBoundingClientRect() }
      : null;
    surface?.setAttribute("data-lit", "");
  });
  dialog.addEventListener("pointerleave", () => {
    glass?.element.removeAttribute("data-lit");
    glass = null;
  });
  dialog.addEventListener("pointermove", (event) => {
    if (glass) {
      glass.x = Math.max(
        0,
        Math.min(
          100,
          ((event.clientX - glass.bounds.x) / glass.bounds.width) * 100,
        ),
      );
      glass.y = Math.max(
        0,
        Math.min(
          100,
          ((event.clientY - glass.bounds.y) / glass.bounds.height) * 100,
        ),
      );
      glass.dirty = true;
      schedule();
    }
    if (!state || !rect || closing) return;
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
        state.maxX -
        ((event.clientX - rect.left) / rect.width) * (state.maxX - state.minX);
      state.y =
        state.maxY -
        ((event.clientY - rect.top) / rect.height) * (state.maxY - state.minY);
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
  function resize() {
    hidePreview();
    rect = null;
    if (dialog.open) {
      const viewport = window.visualViewport;
      dialog.style.width = (viewport?.width || innerWidth) + "px";
      dialog.style.height = (viewport?.height || innerHeight) + "px";
      dialog.style.left = (viewport?.offsetLeft || 0) + "px";
      dialog.style.top = (viewport?.offsetTop || 0) + "px";
      if (closing) return;
      const safe = getComputedStyle(dialog.querySelector(".artwork-safe-area"));
      const source = origin?.isConnected
        ? origin.getBoundingClientRect()
        : state.sourceBounds;
      const opening = artworkOpening(
        {
          width: state.baseWidth,
          height: state.baseHeight,
          x:
            source.x -
            (viewport?.offsetLeft || 0) +
            (source.width - state.baseWidth) / 2,
          y:
            source.y -
            (viewport?.offsetTop || 0) +
            (source.height - state.baseHeight) / 2,
        },
        {
          width: viewport?.width || innerWidth,
          height: viewport?.height || innerHeight,
          safeLeft: parseFloat(safe.paddingLeft),
          safeRight: parseFloat(safe.paddingRight),
          safeTop: parseFloat(safe.paddingTop),
          safeBottom: parseFloat(safe.paddingBottom),
        },
      );
      const atOpening =
        state.initialZoom === undefined ||
        Math.abs(state.zoom - state.initialZoom) < 0.001;
      state.initialZoom = opening.zoom;
      state.minZoom = Math.min(1, opening.zoom);
      if (atOpening) {
        state.zoom = opening.zoom;
        state.x = state.y = 0;
      }
      dialog.style.setProperty("--artwork-gutter-x", opening.gutterX + "px");
      dialog.style.setProperty("--artwork-gutter-y", opening.gutterY + "px");
      state.opening = opening;
      state.centerX = opening.x + opening.width / 2 - opening.gutterX;
      state.centerY = opening.y + opening.height / 2 - opening.gutterY;
      const reveal = dialog.querySelector(".artwork-open-reveal");
      reveal.style.left = opening.x - opening.gutterX + "px";
      reveal.style.top = opening.y - opening.gutterY + "px";
      reveal.style.width = opening.width + "px";
      reveal.style.height = opening.height + "px";
      const details = dialog.querySelector(".artwork-details");
      const controls = dialog.querySelector(".artwork-controls");
      const infoWidth = details.offsetWidth,
        infoHeight = details.offsetHeight;
      const controlsWidth = controls.offsetWidth,
        controlsHeight = controls.offsetHeight;
      const availableWidth = viewport?.width || innerWidth,
        availableHeight = viewport?.height || innerHeight;
      const leftSpace = opening.x - infoWidth - 16;
      const rightSpace = opening.x + opening.width + 16;
      details.style.left =
        (leftSpace >= opening.gutterX ? leftSpace : opening.x + 8) + "px";
      controls.style.left =
        (rightSpace + controlsWidth <= availableWidth - opening.gutterX
          ? rightSpace
          : opening.x + opening.width - controlsWidth - 8) + "px";
      const above = opening.y - infoHeight - 12;
      const infoTop =
        leftSpace >= opening.gutterX
          ? opening.y + 24
          : above >= opening.gutterY
            ? above
            : opening.y + 48;
      details.style.top =
        Math.max(
          opening.gutterY,
          Math.min(infoTop, availableHeight - opening.gutterY - infoHeight),
        ) + "px";
      controls.style.top =
        Math.max(
          opening.gutterY,
          Math.min(
            opening.y + opening.height / 2 - controlsHeight / 2,
            availableHeight - opening.gutterY - controlsHeight,
          ),
        ) + "px";
      glass?.element.removeAttribute("data-lit");
      glass = null;
      schedule();
    }
  }
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
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
        src =
          previewSource?.element === element
            ? previewVisual?.querySelector("img")?.src || image(card)
            : image(card);
      if (dialog.open) return;
      const bounds = element.getBoundingClientRect();
      const visual =
        previewSource?.element === element && !preview.hidden
          ? preview.firstElementChild.getBoundingClientRect()
          : bounds;
      const tilt =
        previewVisual?.style.transform ||
        element.querySelector(".card-image")?.style.transform ||
        "none";
      hidePreview();
      selection = item;
      origin = element;
      origin.classList.add("artwork-source-lifted");
      originKey = element.closest("[data-card-key]")?.dataset.cardKey || null;
      state = {
        sourceBounds: bounds.toJSON(),
        baseWidth: bounds.width,
        baseHeight: bounds.height,
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
      dialog.innerHTML = inspectorView(item, src);
      const artwork = dialog.querySelector(".artwork-full-image");
      artwork.style.width = state.baseWidth + "px";
      artwork.style.height = state.baseHeight + "px";
      const viewport = window.visualViewport;
      const reveal = dialog.querySelector(".artwork-open-reveal");
      dialog.style.setProperty("--artwork-start-tilt", tilt);
      dialog.showModal();
      resize();
      reveal.style.setProperty(
        "--artwork-start-x",
        visual.x +
          visual.width / 2 -
          (viewport?.offsetLeft || 0) -
          state.opening.x -
          state.opening.width / 2 +
          "px",
      );
      reveal.style.setProperty(
        "--artwork-start-y",
        visual.y +
          visual.height / 2 -
          (viewport?.offsetTop || 0) -
          state.opening.y -
          state.opening.height / 2 +
          "px",
      );
      reveal.style.setProperty(
        "--artwork-start-scale",
        String(visual.width / (state.baseWidth * state.zoom)),
      );
      dialog.querySelector("output").value = `${Math.round(state.zoom * 100)}%`;
      if (src)
        upgradeArtwork(dialog.querySelector(".artwork-full-image"), card);
      dialog.focus({ preventScroll: true });
      const openedKey = historyKey;
      document.fonts.ready.then(() => {
        if (dialog.open && historyKey === openedKey) resize();
      });
    },
  };
}
