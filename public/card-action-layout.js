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
  const radius = Math.min(
    tags.length <= 4 ? 112 : 154,
    (viewport.width - 16) / 2,
    (viewport.height - 32) / 2,
    (viewport.width - 102) / 1.58,
  );
  const reachX = Math.max(
    radius,
    radius * (tags.length <= 4 ? 0.58 : 0.79) + 43,
  );
  const center = {
    x: clamp(point.x, reachX + 8, viewport.width - reachX - 8),
    y: clamp(point.y, radius + 8, viewport.height - radius - 8),
  };
  const choices = tags.slice(0, 10);
  if (tags.length > 10)
    choices.splice(9, 1, { id: "more", label: "More tags…", more: true });
  const inner = choices.slice(0, 4),
    outer = choices.slice(4);
  const targets = [inner, outer].flatMap((ring, index) =>
    ring.map((tag, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length;
      const distance =
        radius * (choices.length <= 4 ? 0.58 : index ? 0.79 : 0.4);
      return {
        tag,
        ring: index,
        angle,
        count: ring.length,
        x: center.x + Math.cos(angle) * distance,
        y: center.y + Math.sin(angle) * distance,
      };
    }),
  );
  return { center, radius, targets };
}

export function actionWheelHit(layout, point) {
  const button = layout.targets.find(
    (target) =>
      Math.abs(target.x - point.x) <= 42.5 &&
      Math.abs(target.y - point.y) <= 22,
  );
  if (button) return button;
  const dx = point.x - layout.center.x,
    dy = point.y - layout.center.y,
    distance = Math.hypot(dx, dy);
  if (distance < 22 || distance > layout.radius) return null;
  const ring =
    layout.targets.length <= 4 || distance < layout.radius * 0.59 ? 0 : 1;
  const targets = layout.targets.filter((target) => target.ring === ring);
  const angle = Math.atan2(dy, dx);
  const delta = (target) =>
    Math.abs(
      Math.atan2(
        Math.sin(angle - target.angle),
        Math.cos(angle - target.angle),
      ),
    );
  return targets.sort((a, b) => delta(a) - delta(b))[0] || null;
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
