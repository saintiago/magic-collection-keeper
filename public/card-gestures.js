import {
  actionWheelLayout,
  actionWheelHit,
  rankActionTags,
} from "./card-action-layout.js";
import { image } from "./view.js";

export function createCardGestures({
  resolve,
  tags,
  recent,
  viewer,
  onAction,
  onSettled,
}) {
  let candidate = null,
    active = null,
    hover = null,
    timer = 0,
    frame = 0,
    lastPoint = null,
    suppress = null;
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

  function clearHover() {
    clearTimeout(timer);
    timer = 0;
    viewer.hidePreview();
    if (hover?.image) hover.image.style.transform = "";
    hover = null;
  }
  function cancel({ focus = true } = {}) {
    const held = Boolean(active || candidate);
    clearTimeout(timer);
    timer = 0;
    cancelAnimationFrame(frame);
    frame = 0;
    const origin = active?.element;
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
      ...ranked,
    ];
  }
  function open(item, element, point, keyboard = false) {
    cancel({ focus: false });
    clearHover();
    const all = choices(item),
      layout = actionWheelLayout(all, point, {
        width: innerWidth,
        height: innerHeight,
      });
    active = { item, element, layout, all, keyboard, selected: null };
    layer.hidden = false;
    layer.setAttribute("role", "menu");
    layer.setAttribute("aria-label", `Card actions for ${item.card.name}`);
    layer.style.setProperty("--wheel-x", layout.center.x + "px");
    layer.style.setProperty("--wheel-y", layout.center.y + "px");
    layer.style.setProperty("--wheel-radius", layout.radius + "px");
    const ring = document.createElement("div");
    ring.className = "card-action-rings";
    layer.append(ring);
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
      button.textContent = target.tag.label;
      button.title = target.tag.label;
      button.style.left = target.x + "px";
      button.style.top = target.y + "px";
      button.onclick = () => choose(target.tag);
      layer.append(button);
    });
    const close = document.createElement("button");
    close.className = "card-action-cancel";
    close.textContent = "×";
    close.setAttribute("aria-label", "Cancel card action");
    close.setAttribute("role", "menuitem");
    close.onclick = () => cancel();
    layer.append(close);
    if (keyboard) layer.querySelector("button").focus();
    else {
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
  function choose(tag) {
    if (!active) return;
    const { item, element, all } = active;
    if (!element.isConnected) {
      cancel();
      return;
    }
    cancel();
    if (tag.more)
      return openMore(
        item,
        element,
        all.filter((tag) => !tag.action),
      );
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
      const filtered = all.filter((tag) =>
        tag.label.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()),
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
    more.append(title, input, list, next, close);
    draw();
    more.showModal();
    input.focus();
  }
  function draw() {
    frame = 0;
    if (
      !active &&
      hover?.image &&
      lastPoint &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const r = hover.bounds;
      hover.image.style.transform = `perspective(800px) rotateX(${(0.5 - (lastPoint.y - r.y) / r.height) * 7}deg) rotateY(${((lastPoint.x - r.x) / r.width - 0.5) * 7}deg)`;
      return;
    }
    if (!active || active.keyboard || !lastPoint) return;
    const point = lastPoint;
    ghost.style.transform = `translate(${Math.min(innerWidth - 60, point.x + 24)}px,${Math.max(8, point.y - 90)}px)`;
    const target = actionWheelHit(active.layout, point);
    active.selected = target?.tag || null;
    layer.querySelectorAll("[data-target]").forEach((button, index) => {
      const item = active.layout.targets[index],
        distance = Math.hypot(point.x - item.x, point.y - item.y),
        strength = Math.max(0, 1 - distance / 95);
      button.style.transform = `translate(-50%,-50%) scale(${1 + strength * 0.12})`;
      button.style.opacity = String(0.65 + strength * 0.35);
      button.classList.toggle("selected", target === item);
    });
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      // A fresh press starts a new intention; only the drag's compatibility click is suppressed.
      if (!active) suppress = null;
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
        event.target.closest(
          'dialog[open],.card-action-layer,.card-actions-trigger,[data-action="card-actions"],[data-detail-card-actions]',
        )
      )
        return;
      const found = resolve(event.target);
      if (!found) return;
      clearHover();
      candidate = {
        ...found,
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      };
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
      if (candidate && candidate.pointer !== event.pointerId) return;
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
      if (event.pointerType !== "mouse" || viewer.isOpen || event.buttons)
        return;
      const found = resolve(event.target);
      if (!found || found.item.kind !== "catalog") {
        clearHover();
        return;
      }
      if (hover?.element !== found.element) {
        clearHover();
        const img = found.element.querySelector("img");
        hover = {
          ...found,
          image: img,
          bounds: (img || found.element).getBoundingClientRect(),
        };
        timer = setTimeout(() => {
          if (hover)
            viewer.hover(hover.item.card, hover.image || hover.element);
        }, 220);
      }
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
      if (candidate && candidate.pointer !== event.pointerId) return;
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
      candidate = null;
      if (held) setTimeout(onSettled, 0);
    },
    true,
  );
  document.addEventListener(
    "pointercancel",
    () => cancel({ focus: false }),
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
    const found = resolve(event.target);
    if (!found) return;
    event.preventDefault();
    if (!active)
      open(
        found.item,
        found.element,
        { x: event.clientX, y: event.clientY },
        true,
      );
  });
  document.addEventListener(
    "click",
    (event) => {
      if (
        suppress &&
        performance.now() < suppress.until &&
        (suppress.element.contains(event.target) ||
          event.target.closest(".card-action-layer"))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppress = null;
        return;
      }
      const action = event.target.closest(
        '.card-actions-trigger,[data-action="card-actions"],[data-detail-card-actions]',
      );
      const found = resolve(action || event.target);
      if (!found) return;
      if (action) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const r = found.element.getBoundingClientRect();
        open(
          found.item,
          found.element,
          { x: r.x + r.width / 2, y: r.y + r.height / 2 },
          true,
        );
      } else if (found.item.kind === "catalog") {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearHover();
        if (image(found.item.card)) viewer.open(found.item, found.element);
        else onAction(found.item, { action: "details" }, found.element);
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
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
      if (event.key === "F10" && event.shiftKey) {
        const found = resolve(event.target);
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
    () => {
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
