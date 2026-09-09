import {
  actionWheelLayout,
  actionWheelHit,
  rankActionTags,
  actionTargetWidth,
  wheelPickupSize,
} from "./card-action-layout.js";
import { pointerTilt, approachTilt, tiltTransform } from "./card-tilt.js";
import { image } from "./view.js";
import { createWheelSectors, wheelLabel } from "./card-wheel-view.js";

export function createCardGestures({
  resolve,
  tags,
  recent,
  viewer,
  onAction,
  onSettled,
  createWheelSurface = createWheelSectors,
}) {
  let candidate = null,
    active = null,
    hover = null,
    timer = 0,
    frame = 0,
    lastPoint = null,
    hoverTarget = null,
    hoverDirty = false,
    suppress = null;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)"),
    reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const layer = document.createElement("div");
  layer.className = "card-action-layer";
  layer.hidden = true;
  document.body.append(layer);
  const ghost = document.createElement("img");
  ghost.className = "card-drag-copy";
  ghost.alt = "";
  ghost.draggable = false;
  ghost.hidden = true;
  const more = document.createElement("dialog");
  more.className = "card-action-more";
  document.body.append(more);

  const source = (target) =>
    target.closest("a[data-tag-id]")
      ? null
      : viewer.hoverSource(target) || resolve(target);
  function clearHover() {
    hoverTarget = null;
    hoverDirty = false;
    if (!active) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    clearTimeout(timer);
    timer = 0;
    viewer.hidePreview();
    if (hover?.image) hover.image.style.transform = "";
    hover?.element.closest(".card-tile")?.classList.remove("card-hovered");
    hover = null;
  }
  function cancel({ focus = true } = {}) {
    const held = Boolean(active || candidate);
    clearTimeout(timer);
    timer = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    const origin = active?.element;
    active?.surface.destroy?.();
    candidate?.element.classList.remove("card-pickup");
    active?.element.classList.remove("card-pickup", "card-wheel-source");
    active = null;
    candidate = null;
    layer.hidden = true;
    layer.replaceChildren();
    ghost.hidden = true;
    ghost.removeAttribute("src");
    document.body.classList.remove("card-dragging");
    if (focus && origin?.isConnected) origin.focus({ preventScroll: true });
    if (held) setTimeout(onSettled, 0);
  }
  function choices(item) {
    const ranked = rankActionTags(tags(), recent(), [
      ...(item.row?.tag_ids || []),
      ...(item.row?.locations || []).map((a) => a.tag_id),
    ]);
    return [
      ...ranked,
      {
        id: "details",
        label: item.kind === "pending" ? "Review line" : "Card details",
        action: "details",
      },
      {
        id: "edit",
        label:
          item.kind === "catalog" || item.kind === "reference"
            ? "Review & add"
            : "Edit tags",
        action: "edit",
      },
    ];
  }
  function open(item, element, point, keyboard = false) {
    const selection = getSelection();
    if (
      candidate?.selectionWasEmpty &&
      selection?.anchorNode &&
      element
        .closest(".card-tile,.detail-image,.draft-row")
        ?.contains(selection.anchorNode)
    )
      selection.removeAllRanges();
    const bounds = element.getBoundingClientRect();
    cancel({ focus: false });
    clearHover();
    const all = choices(item),
      width = actionTargetWidth(Math.min(innerWidth, innerHeight)),
      probes = document.createElement("div"),
      heights = new Map();
    const fontText = all
      .slice(0, 10)
      .map((tag) => tag.label)
      .join(" ");
    const wheelFont =
      [...document.fonts].some(
        (face) =>
          face.family.replaceAll('"', "") === "Inter" &&
          face.status === "loaded",
      ) && document.fonts.check('600 13px "Inter"', fontText)
        ? '"Inter"'
        : "Arial";
    document.fonts.load('600 13px "Inter"', fontText).catch(() => {});
    probes.style.setProperty("--wheel-font", wheelFont);
    // Batch writes before reads: one layout flush for all bounded wrapped labels.
    for (const label of new Set([
      ...all.slice(0, 10).map((tag) => tag.label),
      "More tags…",
    ])) {
      const probe = document.createElement("button");
      probe.className = "card-action-target";
      probe.style.cssText = `position:fixed;visibility:hidden;transform:none;height:auto;left:0;top:0;width:${width}px`;
      probe.dataset.label = label;
      wheelLabel(probe, {
        label,
        more: label === "More tags…",
        action: all.some((tag) => tag.label === label && tag.action)
          ? "details"
          : undefined,
      });
      probes.append(probe);
    }
    document.body.append(probes);
    for (const probe of probes.children)
      heights.set(
        probe.dataset.label,
        Math.ceil(probe.getBoundingClientRect().height),
      );
    probes.remove();
    const layout = actionWheelLayout(
      all,
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      {
        width: innerWidth,
        height: innerHeight,
        cardHeight: bounds.height,
        measure: (label) => heights.get(label) || 44,
      },
    );
    active = {
      item,
      element,
      layout,
      all,
      keyboard,
      selected: null,
      ghostWidth: bounds.width,
      ghostHeight: bounds.height,
      grabX: Math.max(0, Math.min(bounds.width, point.x - bounds.x)),
      grabY: Math.max(0, Math.min(bounds.height, point.y - bounds.y)),
    };
    ghost.style.width = active.ghostWidth + "px";
    ghost.style.height = active.ghostHeight + "px";
    layer.hidden = false;
    layer.setAttribute("role", "menu");
    layer.setAttribute("aria-label", `Card actions for ${item.card.name}`);
    layer.style.setProperty("--wheel-x", layout.center.x + "px");
    layer.style.setProperty("--wheel-y", layout.center.y + "px");
    layer.style.setProperty("--wheel-radius", layout.radius + "px");
    layer.style.setProperty("--wheel-font", wheelFont);
    layer.style.setProperty("--wheel-width", (layout.width || 100) + "px");
    layer.style.setProperty("--wheel-height", (layout.height || 100) + "px");
    const material = document.createElement("div");
    material.className = "card-wheel-material";
    material.style.width = material.style.height = layout.radius * 2 + "px";
    material.style.setProperty(
      "--wheel-mask",
      `radial-gradient(circle, transparent ${layout.innerRadius - 1}px, #000 ${layout.innerRadius + 18}px, #000 ${layout.radius - 2}px, transparent ${layout.radius}px)`,
    );
    layer.append(material);
    const wheel = createWheelSurface(layout, choose);
    layer.append(wheel.svg);
    active.sectors = wheel.sectors;
    active.surface = wheel;
    const sourceImage = image(item.card);
    if (sourceImage) {
      const anchor = document.createElement("img");
      anchor.className = "card-action-origin";
      anchor.src = sourceImage;
      anchor.alt = "";
      const pickup = wheelPickupSize(layout, bounds);
      anchor.style.cssText = `left:${layout.center.x - pickup.width / 2}px;top:${layout.center.y - pickup.height / 2}px;width:${pickup.width}px;height:${pickup.height}px`;
      anchor.style.setProperty(
        "--pickup-start-scale",
        String(1 / pickup.scale),
      );
      anchor.style.setProperty(
        "--pickup-x",
        bounds.x + bounds.width / 2 - layout.center.x + "px",
      );
      anchor.style.setProperty(
        "--pickup-y",
        bounds.y + bounds.height / 2 - layout.center.y + "px",
      );
      layer.style.setProperty("--pickup-width", pickup.width + "px");
      layer.style.setProperty("--pickup-height", pickup.height + "px");
      element.classList.add("card-wheel-source");
      layer.append(anchor);
    }
    const caption = document.createElement("span");
    caption.className = "card-action-caption";
    caption.textContent =
      item.kind === "owned"
        ? "1 copy"
        : item.kind === "pending"
          ? "Pending"
          : "Review first";
    layer.append(caption);
    layer.append(ghost);
    layout.targets.forEach((target, index) => {
      const button = document.createElement("button");
      button.className = "card-action-target";
      button.dataset.target = String(index);
      button.dataset.tagId = target.tag.id;
      button.setAttribute("role", "menuitem");
      wheelLabel(button, target.tag);
      button.title = target.tag.label;
      button.style.left = target.x + "px";
      button.style.top = target.y + "px";
      button.style.width = target.width + "px";
      button.style.height = target.height + "px";
      button.onclick = () => choose(target.tag);
      button.onfocus = () => emphasize(index);
      button.onblur = () => emphasize(-1);
      wheel.sectors[index].group.onpointerenter = () => {
        if (active?.keyboard) emphasize(index);
      };
      layer.append(button);
    });
    const close = document.createElement("button");
    close.className = "card-action-cancel";
    close.textContent = "×";
    close.setAttribute("aria-label", "Cancel card action");
    close.setAttribute("role", "menuitem");
    close.onclick = () => cancel();
    layer.append(close);
    active.buttons = [...layer.querySelectorAll("[data-target]")];
    if (keyboard) layer.querySelector("button").focus();
    else {
      element.classList.add("card-pickup");
      document.body.classList.add("card-dragging");
      const src = image(item.card);
      if (src) {
        ghost.src = src;
        ghost.hidden = false;
      }
      lastPoint = point;
      schedule();
    }
  }
  function emphasize(index) {
    if (!active) return;
    active.surface.paint(active.sectors.map((_, i) => (i === index ? 1 : 0)));
  }
  function choose(tag) {
    if (!active) return;
    const { item, element, all } = active;
    if (!element.isConnected) {
      cancel();
      return;
    }
    cancel();
    if (tag.more) return openMore(item, element, all);
    onAction(item, tag, element);
  }
  function openMore(item, element, all) {
    more.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = "Choose a tag";
    const input = document.createElement("input");
    input.placeholder = "Find a tag";
    input.setAttribute("aria-label", "Find a tag");
    const list = document.createElement("div"),
      next = document.createElement("button"),
      close = document.createElement("button");
    next.textContent = "More tags";
    close.textContent = "Cancel";
    let offset = 0;
    const draw = () => {
      const filtered = all.filter(
        (tag) =>
          !tag.action &&
          tag.label
            .toLocaleLowerCase()
            .includes(input.value.toLocaleLowerCase()),
      );
      list.replaceChildren();
      for (const tag of filtered.slice(offset, offset + 20)) {
        const button = document.createElement("button");
        button.textContent = tag.label;
        button.onclick = () => {
          more.close();
          if (element.isConnected) onAction(item, tag, element);
        };
        list.append(button);
      }
      next.hidden = offset + 20 >= filtered.length;
    };
    input.oninput = () => {
      offset = 0;
      draw();
    };
    next.onclick = () => {
      offset += 20;
      draw();
    };
    close.onclick = () => more.close();
    const actions = document.createElement("nav");
    actions.className = "card-more-actions";
    actions.setAttribute("aria-label", "Other card actions");
    for (const tag of all.filter((tag) => tag.action)) {
      const button = document.createElement("button");
      button.textContent = tag.label;
      button.onclick = () => {
        more.close();
        if (element.isConnected) onAction(item, tag, element);
      };
      actions.append(button);
    }
    more.append(title, actions, input, list, next, close);
    draw();
    more.showModal();
    input.focus();
  }
  function draw(time) {
    frame = 0;
    if (!active && hoverDirty) updateHover();
    if (!active && hover?.image && lastPoint && !reducedMotion.matches) {
      const target = pointerTilt(hover.bounds, lastPoint);
      const next = approachTilt(
        hover.tilt,
        target,
        hover.time ? time - hover.time : 16,
      );
      hover.time = time;
      hover.tilt = next;
      const transform = tiltTransform(next);
      hover.image.style.transform = transform;
      viewer.setHoverTilt(transform);
      if (!next.settled) schedule();
      return;
    }
    if (!active || active.keyboard || !lastPoint) return;
    const point = lastPoint;
    ghost.style.transform = `translate(${point.x - active.grabX}px,${point.y - active.grabY}px)`;
    const target = actionWheelHit(active.layout, point);
    active.selected = target?.tag || null;
    ghost.style.opacity = target ? "0.16" : "0.32";
    const strengths = active.buttons.map((button, index) => {
      const item = active.layout.targets[index],
        distance = Math.hypot(point.x - item.x, point.y - item.y),
        strength = Math.max(0, 1 - distance / (active.layout.radius * 0.7));
      button.classList.toggle("selected", target === item);
      return target === item ? Math.max(0.65, strength) : strength * 0.55;
    });
    active.surface.paint(strengths, point);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function updateHover() {
    const target = hoverTarget;
    hoverDirty = false;
    if (!target?.isConnected) return clearHover();
    const found =
      viewer.hoverSource(target) ||
      resolve(
        target.closest("a[data-tag-id]")?.closest(".card-tile") || target,
      );
    if (!found) return clearHover();
    if (hover?.element === found.element && !hover.interrupted) return;
    // Read the stable input plane before changing either visual's styles.
    const bounds = found.element.getBoundingClientRect();
    clearHover();
    hoverTarget = target;
    const img = found.element.matches("img")
      ? found.element
      : found.element.querySelector(".card-image") ||
        found.element.querySelector("img");
    hover = { ...found, image: img, bounds, tilt: { x: 0, y: 0 }, time: 0 };
    found.element.closest(".card-tile")?.classList.add("card-hovered");
    timer = setTimeout(() => {
      timer = 0;
      if (!hover) return;
      const bounds = viewer.hover(
        hover,
        hover.bounds,
        tiltTransform(hover.tilt),
      );
      if (bounds) hover.bounds = bounds;
      schedule();
    }, 300);
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      // A fresh press starts a new intention; only the drag's compatibility click is suppressed.
      if (!active || active.keyboard) suppress = null;
      if (candidate && candidate.pointer !== event.pointerId) {
        suppress = {
          element: candidate.element,
          until: performance.now() + 600,
        };
        cancel({ focus: false });
        return;
      }
      if (active?.keyboard && !layer.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppress = { element: event.target, until: performance.now() + 600 };
        cancel({ focus: false });
        return;
      }
      if (
        event.button !== 0 ||
        active ||
        viewer.isOpen ||
        event.target.closest("dialog[open],.card-action-layer,a[data-tag-id]")
      )
        return;
      const found = source(event.target);
      if (!found) return;
      clearTimeout(timer);
      timer = 0;
      candidate = {
        ...found,
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
        selectionWasEmpty: getSelection()?.isCollapsed !== false,
      };
      found.element.classList.add("card-pickup");
      if (event.pointerType !== "mouse")
        timer = setTimeout(() => {
          if (!candidate) return;
          const c = candidate;
          open(c.item, c.element, { x: c.x, y: c.y });
          candidate = c;
          try {
            c.element.setPointerCapture(c.pointer);
          } catch {}
        }, 360);
    },
    true,
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (
        candidate &&
        (candidate.pointer !== event.pointerId ||
          candidate.type !== event.pointerType)
      )
        return;
      if (active && !active.keyboard) {
        event.preventDefault();
        lastPoint = { x: event.clientX, y: event.clientY };
        schedule();
        return;
      }
      if (candidate) {
        const distance = Math.hypot(
          event.clientX - candidate.x,
          event.clientY - candidate.y,
        );
        if (distance > 8) {
          if (candidate.type === "mouse") {
            const c = candidate;
            open(c.item, c.element, { x: c.x, y: c.y });
            candidate = c;
            lastPoint = { x: event.clientX, y: event.clientY };
            try {
              c.element.setPointerCapture(c.pointer);
            } catch {}
            schedule();
          } else {
            suppress = {
              element: candidate.element,
              until: performance.now() + 600,
            };
            cancel({ focus: false });
          }
        }
        return;
      }
      if (
        event.pointerType !== "mouse" ||
        !finePointer.matches ||
        viewer.isOpen ||
        event.buttons
      )
        return;
      // Cancel a departing dwell immediately, even if its deadline falls before
      // the next frame. Resolve geometry and update visuals in that frame.
      if (
        timer &&
        hover &&
        !hover.element.contains(event.target) &&
        !hover.element.closest(".card-tile")?.contains(event.target) &&
        !viewer.hoverSource(event.target)
      ) {
        clearTimeout(timer);
        timer = 0;
        hover.interrupted = true;
      }
      hoverTarget = event.target;
      hoverDirty = true;
      lastPoint = { x: event.clientX, y: event.clientY };
      schedule();
    },
    { passive: false, capture: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (active && !active.keyboard) event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      if (
        candidate &&
        (candidate.pointer !== event.pointerId ||
          candidate.type !== event.pointerType)
      )
        return;
      clearTimeout(timer);
      timer = 0;
      if (active && !active.keyboard) {
        event.preventDefault();
        event.stopPropagation();
        const { item, element } = active;
        suppress = { element, until: performance.now() + 800 };
        const point = { x: event.clientX, y: event.clientY },
          target = actionWheelHit(active.layout, point)?.tag;
        const link = document
          .elementFromPoint(point.x, point.y)
          ?.closest("a[data-tag-id]");
        const direct =
          !target && link
            ? tags().find((tag) => tag.id === link.dataset.tagId)
            : null;
        if (target || direct) choose(target || direct);
        else cancel();
      }
      const held = Boolean(candidate);
      candidate?.element.classList.remove("card-pickup");
      candidate = null;
      if (held) setTimeout(onSettled, 0);
    },
    true,
  );
  document.addEventListener(
    "lostpointercapture",
    (event) => {
      if (candidate?.pointer !== event.pointerId || !active) return;
      suppress = { element: active.element, until: performance.now() + 800 };
      cancel({ focus: false });
    },
    true,
  );
  document.addEventListener(
    "pointercancel",
    () => {
      clearHover();
      cancel({ focus: false });
    },
    true,
  );
  document.addEventListener(
    "selectstart",
    (event) => {
      if (candidate || (active && !active.keyboard)) event.preventDefault();
    },
    true,
  );
  document.addEventListener(
    "dragstart",
    (event) => {
      if (resolve(event.target)) event.preventDefault();
    },
    true,
  );
  document.addEventListener("contextmenu", (event) => {
    const found = source(event.target);
    if (!found) return;
    event.preventDefault();
  });
  document.addEventListener(
    "click",
    (event) => {
      if (suppress && performance.now() < suppress.until) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppress = null;
        return;
      }
      const found = source(event.target);
      if (!found || viewer.isOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      viewer.open(found.item, found.element);
      clearHover();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!active && (event.key === "Enter" || event.key === " "))
        suppress = null;
      if (event.key === "Escape" && (active || candidate)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppress = {
          element: active?.element || candidate.element,
          until: performance.now() + 800,
        };
        cancel();
        return;
      }
      if (active?.keyboard) {
        const buttons = [...layer.querySelectorAll("button")],
          index = buttons.indexOf(document.activeElement);
        if (
          ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Tab"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          const backwards =
            event.shiftKey || ["ArrowUp", "ArrowLeft"].includes(event.key);
          buttons[
            (index + (backwards ? -1 : 1) + buttons.length) % buttons.length
          ].focus();
        }
        return;
      }
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target.matches("[role=button]")
      ) {
        const found = source(event.target);
        if (found) {
          event.preventDefault();
          viewer.open(found.item, found.element);
        }
      }
      if (event.key === "F10" && event.shiftKey) {
        const found = source(event.target);
        if (found) {
          event.preventDefault();
          const r = found.element.getBoundingClientRect();
          open(
            found.item,
            found.element,
            { x: r.x + r.width / 2, y: r.y + r.height / 2 },
            true,
          );
        }
      }
    },
    true,
  );
  const leave = () => {
    clearHover();
    cancel({ focus: false });
    if (more.open) more.close();
  };
  window.addEventListener(
    "scroll",
    (event) => {
      if (event.target.closest?.(".card-hover-info")) return;
      clearHover();
      if (!active && candidate) cancel({ focus: false });
    },
    true,
  );
  window.addEventListener("resize", leave);
  window.addEventListener("popstate", leave);
  window.addEventListener("hashchange", leave);
  window.addEventListener("pagehide", leave);
  window.addEventListener("keeper-sign-out", leave);
  window.addEventListener("blur", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) leave();
  });
  document.addEventListener("pointerout", (event) => {
    if (!event.relatedTarget) clearHover();
  });
  return {
    get holding() {
      return Boolean(active || candidate);
    },
    cancel: leave,
    open: (item, element) => {
      const r = element.getBoundingClientRect();
      open(
        item,
        element,
        { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        true,
      );
    },
  };
}
