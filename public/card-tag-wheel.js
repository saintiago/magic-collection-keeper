import {
  actionWheelLayout,
  actionTargetWidth,
  actionWheelHit,
} from "./card-action-layout.js";
import { createWheelSectors } from "./card-wheel-view.js";
import { mountCardTags } from "./card-tag-view.js";

// Touch presentation of the same tag state. Slots stay fixed while assignments
// settle; only labels and selected/pending/error states change.
export function mountCardTagWheel(root, state) {
  root.className = "artwork-touch-wheel";
  const ring = document.createElement("div");
  ring.className = "card-tag-ring";
  const status = document.createElement("p");
  status.className = "card-wheel-status";
  status.id = "wheel-status-" + crypto.randomUUID();
  status.setAttribute("role", "status");
  const overflow = document.createElement("aside");
  overflow.className = "card-wheel-overflow";
  overflow.hidden = true;
  const back = document.createElement("button");
  back.className = "card-tags-retry";
  back.textContent = "Back to tag wheel";
  const all = document.createElement("div");
  overflow.append(back, all);
  root.replaceChildren(ring, status, overflow);
  const unmountAll = mountCardTags(all, state);
  let geometry = null,
    signature = "",
    layout = null,
    surface = null;
  const buttons = new Map();
  let pressed = null,
    drag = null;
  const assigned = (id) =>
    state.view.desired.has(id)
      ? state.view.desired.get(id)
      : state.view.confirmed.has(id);
  function choose(tag) {
    if (tag.more) {
      overflow.hidden = false;
      ring.hidden = true;
      back.focus();
      return;
    }
    state.set(
      tag.id,
      pressed?.id === tag.id ? pressed.selected : !assigned(tag.id),
    );
    pressed = null;
  }
  function closeMore() {
    overflow.hidden = true;
    ring.hidden = false;
    ring.querySelector('[data-wheel-tag="more"]')?.focus();
  }
  back.onclick = closeMore;
  overflow.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeMore();
  });
  root.addEventListener("pointerdown", (event) => {
    const id = event.target.closest("[data-wheel-tag]")?.dataset.wheelTag;
    pressed = id ? { id, selected: !assigned(id) } : null;
  });
  root.addEventListener("pointercancel", () => {
    pressed = null;
  });
  root.addEventListener("keydown", () => {
    pressed = null;
  });
  function rebuild() {
    if (!geometry) return;
    const { opening, viewport } = geometry;
    const width = actionTargetWidth(Math.min(viewport.width, viewport.height));
    const choices = state.view.tags.map((tag) => ({
      ...tag,
      tagLabel: tag.label,
      label: "Remove " + tag.label,
    }));
    const probes = document.createElement("div"),
      heights = new Map();
    for (const tag of [...choices, { label: "More tags…" }]) {
      const probe = document.createElement("button");
      probe.className = "card-action-target";
      probe.textContent = tag.label;
      probe.style.cssText = `position:absolute;visibility:hidden;transform:none;width:${width}px;height:auto`;
      probes.append(probe);
    }
    root.append(probes);
    for (const probe of probes.children)
      heights.set(
        probe.textContent,
        Math.ceil(probe.getBoundingClientRect().height),
      );
    probes.remove();
    layout = actionWheelLayout(
      choices,
      {
        x: opening.x + opening.width / 2,
        y: opening.y + opening.height / 2,
      },
      {
        ...viewport,
        cardHeight: opening.height,
        maxRadius: Math.min(
          350,
          opening.x + opening.width / 2 - 24,
          viewport.width - 24 - opening.x - opening.width / 2,
          opening.y + opening.height / 2 - 32,
          viewport.height - 32 - opening.y - opening.height / 2,
        ),
        measure: (label) => heights.get(label) || 52,
      },
    );
    surface?.destroy?.();
    ring.replaceChildren();
    buttons.clear();
    ring.style.setProperty("--wheel-x", layout.center.x + "px");
    ring.style.setProperty("--wheel-y", layout.center.y + "px");
    surface = createWheelSectors(layout, choose);
    ring.append(surface.svg);
    for (const [index, target] of layout.targets.entries()) {
      const button = document.createElement("button");
      button.className = "card-action-target card-wheel-tag";
      button.dataset.wheelTag = target.tag.id;
      button.style.cssText = `left:${target.x}px;top:${target.y}px;width:${target.width}px;height:${target.height}px`;
      button.setAttribute("aria-describedby", status.id);
      button.onclick = () => choose(target.tag);
      button.onfocus = () =>
        surface.paint(layout.targets.map((_, i) => (i === index ? 1 : 0)));
      button.onblur = () => surface.paint([]);
      surface.sectors[index].group.dataset.wheelTag = target.tag.id;
      ring.append(button);
      buttons.set(target.tag.id, button);
    }
  }
  function render() {
    const view = state.view;
    const next = JSON.stringify(
      view.tags
        .map((tag) => [tag.id, tag.label])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    if (next !== signature && !drag) {
      signature = next;
      rebuild();
    }
    status.textContent =
      view.loadError ||
      (view.loading
        ? "Loading tags…"
        : !view.tags.length
          ? "No tags available."
          : [...view.errors]
              .map(
                ([id, error]) =>
                  `${view.tags.find((tag) => tag.id === id)?.label || "Tag"}: ${error}`,
              )
              .join(" "));
    status.hidden = !status.textContent;
    if (view.loadError) {
      overflow.hidden = false;
      ring.hidden = true;
    }
    for (const target of layout?.targets || []) {
      const tag = target.tag,
        button = buttons.get(tag.id);
      if (tag.more) {
        button.textContent = tag.label;
        continue;
      }
      const selected = drag?.assigned.get(tag.id) ?? assigned(tag.id),
        current = view.tags.find((entry) => entry.id === tag.id);
      button.textContent =
        (selected ? "Remove " : "Add ") +
        (drag ? tag.tagLabel : current?.label || tag.tagLabel);
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute(
        "aria-busy",
        String(view.busy === tag.id || view.desired.has(tag.id)),
      );
      button.classList.toggle("has-error", view.errors.has(tag.id));
      button.disabled = view.loading || Boolean(view.loadError);
    }
  }
  const unsubscribe = state.subscribe(render);
  return {
    beginDrag() {
      if (
        !layout ||
        state.view.loading ||
        state.view.loadError ||
        !overflow.hidden
      )
        return false;
      drag = {
        layout,
        assigned: new Map(
          state.view.tags.map((tag) => [tag.id, assigned(tag.id)]),
        ),
      };
      return true;
    },
    highlightDrag(point) {
      if (!drag) return;
      const target = actionWheelHit(drag.layout, point);
      surface.paint(
        drag.layout.targets.map((entry) => (entry === target ? 1 : 0)),
      );
    },
    drop(point) {
      if (!drag) return;
      const target = actionWheelHit(drag.layout, point)?.tag;
      if (target?.more) choose(target);
      else if (target) state.set(target.id, !drag.assigned.get(target.id));
    },
    cancelDrag() {
      if (!drag) return;
      drag = null;
      surface?.paint([]);
      render();
    },
    resize(next) {
      geometry = next;
      rebuild();
      render();
    },
    destroy() {
      unsubscribe();
      unmountAll();
      surface?.destroy?.();
    },
  };
}
