export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const actionTargetWidth = (width) =>
  Math.min(112, Math.max(64, ((width - 36) / 2) * 0.48));

// Scale the rendered, untransformed source tile exactly. Edges affect position,
// never the requested scale; oversized artwork may extend past the viewport.
export function enlargedArtwork(bounds, scale, viewport) {
  const width = bounds.width * scale,
    height = bounds.height * scale;
  const place = (start, source, size, available) =>
    size > available - 24
      ? (available - size) / 2
      : clamp(start + (source - size) / 2, 12, available - size - 12);
  return {
    width,
    height,
    x: place(bounds.x, bounds.width, width, viewport.width),
    y: place(bounds.y, bounds.height, height, viewport.height),
  };
}

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

// True annular hit sectors and label geometry are frozen for the whole gesture.
export function actionWheelLayout(tags, point, viewport) {
  const available = Math.min(viewport.width, viewport.height);
  const radius = Math.max(
    36,
    Math.min(
      350,
      Math.max(292, (viewport.cardHeight || 240) * 1.04),
      (available - 36) / 2,
    ),
  );
  const innerRadius =
    radius * (0.42 + 0.16 * clamp((available - 320) / 480, 0, 1));
  const labelRadius = innerRadius + (radius - innerRadius) * 0.52;
  const width = actionTargetWidth(available);
  const measure = viewport.measure || (() => 52);
  // A label that cannot fit the glass band stays fully readable in More tags.
  const eligible = tags.filter(
    (tag) =>
      measure(tag.label, width) <= Math.max(44, (radius - innerRadius) * 0.92),
  );
  const center = {
    x: clamp(point.x, radius + 18, viewport.width - radius - 18),
    y: clamp(point.y, radius + 18, viewport.height - radius - 18),
  };
  let targets = [];
  for (
    let count = Math.min(
      eligible.length + Number(eligible.length < tags.length),
      available >= 650 ? 10 : 6,
    );
    count >= Math.min(3, eligible.length);
    count--
  ) {
    const choices = eligible.slice(0, count);
    if (tags.length > count)
      choices[Math.min(count - 1, choices.length)] = {
        id: "more",
        label: "More tags…",
        more: true,
      };
    targets = choices.map((tag, i) => {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / count;
      return {
        tag,
        ring: 0,
        angle,
        count,
        width,
        height: Math.max(44, measure(tag.label, width)),
        x: center.x + Math.cos(angle) * labelRadius,
        y: center.y + Math.sin(angle) * labelRadius,
      };
    });
    const fits = targets.every((target) => {
      for (const dx of [-target.width / 2, target.width / 2]) {
        for (const dy of [-target.height / 2, target.height / 2]) {
          const x = target.x - center.x + dx,
            y = target.y - center.y + dy;
          const distance = Math.hypot(x, y);
          const angle = Math.atan2(
            Math.sin(Math.atan2(y, x) - target.angle),
            Math.cos(Math.atan2(y, x) - target.angle),
          );
          if (
            distance > radius - 3 ||
            distance < innerRadius + 3 ||
            Math.abs(angle) > Math.PI / count - 0.035
          )
            return false;
        }
      }
      return true;
    });
    if (fits) break;
  }
  return {
    center,
    radius,
    innerRadius,
    width: radius * 2,
    height: radius * 2,
    targets,
  };
}

export function actionWheelHit(layout, point) {
  const x = point.x - layout.center.x,
    y = point.y - layout.center.y;
  const distance = Math.hypot(x, y);
  if (distance < layout.innerRadius || distance > layout.radius) return null;
  const angle = Math.atan2(y, x);
  return (
    layout.targets.find(
      (target) =>
        Math.abs(
          Math.atan2(
            Math.sin(angle - target.angle),
            Math.cos(angle - target.angle),
          ),
        ) <=
        Math.PI / target.count,
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
