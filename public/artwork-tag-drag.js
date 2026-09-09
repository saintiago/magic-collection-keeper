// A temporary touch-drag copy belongs to the open artwork only. The opaque
// artwork stays put; pointer updates are painted once per animation frame.
export function createArtworkTagDrag({ dialog, wheel }) {
  let active = null,
    ghost = null,
    frame = 0;
  const point = (event) => ({
    x: event.clientX - (window.visualViewport?.offsetLeft || 0),
    y: event.clientY - (window.visualViewport?.offsetTop || 0),
  });
  function paint() {
    frame = 0;
    if (!active?.moved) return;
    if (!ghost) {
      ghost = document.createElement("img");
      ghost.className = "artwork-touch-drag-copy";
      ghost.alt = "";
      ghost.draggable = false;
      ghost.src = active.src;
      ghost.style.width = active.width + "px";
      ghost.style.height = active.height + "px";
      dialog.append(ghost);
    }
    ghost.style.transform = `translate(${active.point.x - active.grabX}px,${active.point.y - active.grabY}px)`;
    wheel()?.highlightDrag(active.point);
  }
  function cancel() {
    cancelAnimationFrame(frame);
    frame = 0;
    ghost?.remove();
    ghost = null;
    active = null;
    wheel()?.cancelDrag();
  }
  return {
    get active() {
      return Boolean(active);
    },
    start(event) {
      cancel();
      if (!wheel()?.beginDrag()) return;
      const image = dialog.querySelector(".artwork-full-image");
      const bounds = image.getBoundingClientRect();
      active = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        point: point(event),
        moved: false,
        src: image.currentSrc || image.src,
        width: bounds.width,
        height: bounds.height,
        grabX: event.clientX - bounds.x,
        grabY: event.clientY - bounds.y,
      };
    },
    move(event) {
      if (!active || active.id !== event.pointerId) return false;
      active.point = point(event);
      active.moved ||=
        Math.hypot(
          event.clientX - active.startX,
          event.clientY - active.startY,
        ) > 8;
      if (active.moved && !frame) frame = requestAnimationFrame(paint);
      return true;
    },
    end(event) {
      if (!active || active.id !== event.pointerId) return false;
      const moved = active.moved;
      if (moved && event.type === "pointerup") wheel()?.drop(point(event));
      cancel();
      return moved;
    },
    cancel,
  };
}
