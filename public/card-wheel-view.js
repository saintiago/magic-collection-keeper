const namespace = "http://www.w3.org/2000/svg";
const svgNode = (name, attributes = {}) => {
  const node = document.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, value);
  return node;
};

export function wheelLabel(button, tag) {
  const label = document.createElement("span");
  label.className = "card-action-label";
  label.textContent = tag.label;
  button.append(label);
}

export function wheelSectorPath(radius, inner, start, end) {
  const point = (r, angle) =>
    `${radius + r * Math.cos(angle)},${radius + r * Math.sin(angle)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(radius, start)} A ${radius},${radius} 0 ${large} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner},${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}

export function createWheelSectors(layout, choose) {
  const diameter = layout.radius * 2;
  const svg = svgNode("svg", {
    viewBox: `0 0 ${diameter} ${diameter}`,
    "aria-hidden": "true",
    class: "card-action-sectors",
  });
  svg.style.width = diameter + "px";
  svg.style.height = diameter + "px";
  const id = `wheel-${crypto.randomUUID()}`;
  const defs = svgNode("defs");
  const glass = svgNode("radialGradient", {
    id: id + "-glass",
    gradientUnits: "userSpaceOnUse",
    cx: layout.radius,
    cy: layout.radius,
    r: layout.radius,
  });
  for (const [offset, color, opacity] of [
    ["30%", "#23473a", 0],
    ["52%", "#d6f4df", 0.02],
    ["78%", "#19392f", 0.035],
    ["96%", "#416552", 0.05],
    ["100%", "#e8fff0", 0.25],
  ])
    glass.append(
      svgNode("stop", { offset, "stop-color": color, "stop-opacity": opacity }),
    );
  const gradient = svgNode("radialGradient", {
    id,
    gradientUnits: "userSpaceOnUse",
    cx: layout.radius,
    cy: layout.radius,
    r: layout.radius,
  });
  for (const [offset, color, opacity] of [
    ["34%", "#b2a76e", 0],
    ["48%", "#c9efb3", 0.08],
    ["74%", "#8ee5bb", 0.12],
    ["94%", "#c7ffdb", 0.26],
    ["100%", "#507262", 0.02],
  ])
    gradient.append(
      svgNode("stop", { offset, "stop-color": color, "stop-opacity": opacity }),
    );
  const texture = svgNode("pattern", {
    id: id + "-grain",
    width: 23,
    height: 19,
    patternUnits: "userSpaceOnUse",
  });
  for (const [cx, cy, r] of [
    [2, 4, 0.5],
    [14, 7, 0.4],
    [8, 16, 0.6],
    [20, 14, 0.35],
  ])
    texture.append(
      svgNode("circle", { cx, cy, r, fill: "#e8ead8", opacity: 0.12 }),
    );
  defs.append(glass, gradient, texture);
  svg.append(defs);
  const sectors = layout.targets.map((target) => {
    const d = wheelSectorPath(
      layout.radius,
      layout.innerRadius,
      target.angle - Math.PI / target.count + 0.001,
      target.angle + Math.PI / target.count - 0.001,
    );
    const group = svgNode("g", { class: "card-action-sector" });
    const base = svgNode("path", {
      d,
      class: "card-action-sector-base",
      fill: `url(#${id}-glass)`,
    });
    const glow = svgNode("path", {
      d,
      fill: `url(#${id})`,
      class: "card-action-sector-glow",
    });
    const grain = svgNode("path", {
      d,
      fill: `url(#${id}-grain)`,
      "pointer-events": "none",
    });
    group.append(base, glow, grain);
    group.onclick = () => choose(target.tag);
    svg.append(group);
    return { group, glow };
  });
  return {
    svg,
    sectors,
    paint: (strengths) =>
      sectors.forEach(({ glow }, i) => {
        glow.style.opacity = String(strengths[i] || 0);
      }),
  };
}
