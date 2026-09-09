export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function rankActionTags(tags, recent = [], assigned = []) {
  const recency = new Map(recent.map((id, index) => [id, index]));
  return tags
    .filter((tag) => !tag.id.startsWith("system:"))
    .slice()
    .sort(
      (a, b) =>
        (recency.get(a.id) ?? 100) - (recency.get(b.id) ?? 100) ||
        Number(assigned.includes(b.id)) - Number(assigned.includes(a.id)) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
}

// Geometry is captured once per gesture. Emphasis never changes these targets.
export function actionWheelLayout(tags, point, viewport) {
  const margin = 18,
    width = Math.min(128, Math.max(84, (viewport.width - 48) / 3));
  const measure = viewport.measure || (() => 52);
  // Fit actual wrapped labels, reducing to a bounded More list when needed.
  let result;
  for (
    let count = Math.min(
      tags.length,
      viewport.width >= 850 && viewport.height >= 650 ? 10 : 6,
    );
    count >= 3 || count === tags.length;
    count--
  ) {
    const choices = tags.slice(0, count);
    if (tags.length > count)
      choices[count - 1] = { id: "more", label: "More tags…", more: true };
    const dimensions = choices.map((tag) => ({
      width,
      height: Math.max(44, measure(tag.label, width)),
    }));
    for (
      let radius = Math.max(132, (viewport.cardHeight || 220) / 2 + 48);
      radius <= Math.max(viewport.width, viewport.height);
      radius += 4
    ) {
      const targets = choices.map((tag, i) => {
        const angle = -Math.PI / 2 + (i * Math.PI * 2) / choices.length;
        return {
          tag,
          ring: 0,
          angle,
          count: choices.length,
          x:
            Math.cos(angle) *
            Math.min(radius, (viewport.width - width * 1.08 - margin * 2) / 2),
          y: Math.sin(angle) * radius,
          ...dimensions[i],
        };
      });
      const left = Math.min(...targets.map((t) => t.x - t.width * 0.54)),
        right = Math.max(...targets.map((t) => t.x + t.width * 0.54)),
        top = Math.min(...targets.map((t) => t.y - t.height * 0.54)),
        bottom = Math.max(...targets.map((t) => t.y + t.height * 0.54));
      if (
        right - left > viewport.width - margin * 2 ||
        bottom - top > viewport.height - margin * 2 - 20
      )
        break;
      const overlap = targets.some((a, i) =>
        targets
          .slice(i + 1)
          .some(
            (b) =>
              Math.abs(a.x - b.x) < (a.width + b.width) * 0.54 + 4 &&
              Math.abs(a.y - b.y) < (a.height + b.height) * 0.54 + 4,
          ),
      );
      if (overlap) continue;
      const center = {
        x: clamp(point.x, margin - left, viewport.width - margin - right),
        y: clamp(point.y, margin - top, viewport.height - margin - 20 - bottom),
      };
      result = {
        center,
        radius: radius + 32,
        width: right - left,
        height: bottom - top,
        targets: targets.map((t) => ({
          ...t,
          x: t.x + center.x,
          y: t.y + center.y,
        })),
      };
      break;
    }
    if (result || count <= 3) break;
  }
  // Extremely small zoomed viewports retain two core actions and a scrollable tag list.
  if (!result) {
    const choices = [
      tags[0],
      tags[1],
      { id: "more", label: "More tags…", more: true },
    ].filter(Boolean);
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    result = {
      center,
      radius: 0,
      targets: choices.map((tag, i) => ({
        tag,
        ring: 0,
        angle: 0,
        x: center.x,
        y: 36 + i * 56,
        width: Math.max(80, viewport.width - 36),
        height: 48,
      })),
    };
  }
  return result;
}

export function actionWheelHit(layout, point) {
  return (
    layout.targets.find(
      (target) =>
        Math.abs(target.x - point.x) <= target.width / 2 &&
        Math.abs(target.y - point.y) <= target.height / 2,
    ) || null
  );
}

export function boundedArtwork({
  width,
  height,
  baseWidth,
  baseHeight,
  zoom,
  x = 0,
  y = 0,
}) {
  const scale = clamp(zoom, 1, 6),
    limitX = Math.max(0, (baseWidth * scale - width) / 2),
    limitY = Math.max(0, (baseHeight * scale - height) / 2);
  return {
    zoom: scale,
    x: limitX ? clamp(x, -limitX, limitX) : 0,
    y: limitY ? clamp(y, -limitY, limitY) : 0,
    limitX,
    limitY,
  };
}
