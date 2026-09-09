import { collectionCard } from "/collection-view.js";
import { homeContent } from "/home-view.js";
import { createArtworkViewer } from "/artwork-viewer.js";
import { createCardGestures } from "/card-gestures.js";
import { createWheelSectors } from "/card-wheel-view.js";
import { createWebGLWheel } from "/wheel-webgl.js";
const card = await fetch("/cards.json").then((r) => r.json());
const tags = [
  "Double Dragon",
  "A long readable deck label",
  "Draft Box",
  "Card Draw",
  "Favorites",
  "Trade binder",
].map((label, i) => ({
  id: `prototype-tag-${i}`,
  label,
  type: i === 3 ? "role" : "location",
  kind: i === 3 ? "role" : i === 5 ? "binder" : i === 2 ? "box" : "deck",
}));
const rows = Array.from({ length: 1000 }, (_, i) => ({
  id: `prototype-row-${i}`,
  printing_id: card.id,
  card,
  quantity: 3,
  finish: "nonfoil",
  condition: "NM",
  locations: [{ tag_id: tags[0].id, quantity: 1, tag: tags[0] }],
  tag_ids: [tags[3].id],
  tags: [tags[3]],
  allocated_quantity: 1,
}));
let mode = "deck",
  gestures;
const status = document.querySelector("#prototype-status");
const viewer = createArtworkViewer({
  onDetails: () =>
    (status.textContent =
      "Prototype: Card details selected. No account or API is connected."),
  onEdit: () =>
    (status.textContent =
      "Prototype: tag editing selected. No account or API is connected."),
  onTag: (tag) => (status.textContent = `Prototype tag: ${tag.label}`),
  onQuantity: async (item, quantity) => {
    item.row.quantity = quantity;
    status.textContent = "Sample quantity updated in memory only.";
    return item.row;
  },
});
function resolve(target) {
  const button = target.closest(".card-tile")?.querySelector("button");
  if (!button) return null;
  const row =
    rows[Number(button.dataset.index || button.dataset.homeCard || 0)];
  return {
    element: button,
    item: {
      kind: mode === "catalog" ? "catalog" : "owned",
      card,
      row: mode === "catalog" ? { card } : row,
    },
  };
}
gestures = createCardGestures({
  resolve,
  tags: () => tags,
  recent: () => [],
  viewer,
  onAction: (_, tag) => {
    status.textContent = `Prototype: ${tag.label} selected. No ownership was changed.`;
  },
  onSettled: () => {},
  createWheelSurface: (layout, choose) => {
    if (document.querySelector("#renderer").value === "webgl")
      return createWebGLWheel(layout, choose, (result) => {
        window.prototypeRenderer = result;
        document.querySelector("#renderer-status").textContent =
          result.renderer === "webgl"
            ? "WebGL lighting · local comparison"
            : result.reason;
      });
    window.prototypeRenderer = { renderer: "svg", idleLoop: false };
    document.querySelector("#renderer-status").textContent = "SVG glass";
    return createWheelSectors(layout, choose);
  },
});
function render() {
  gestures.cancel();
  mode = document.querySelector("#surface").value;
  document.body.dataset.mode = mode === "catalog" ? "catalog" : "collection";
  const grid = document.querySelector("#grid"),
    home = document.querySelector("#home-page");
  grid.hidden = mode === "home";
  home.hidden = mode !== "home";
  if (mode === "home") {
    grid.replaceChildren();
    home.innerHTML = homeContent({
      activity: {
        status: "ready",
        entries: [
          {
            kind: "card",
            name: card.name,
            printing_id: card.id,
            oracle_id: card.oracle_id,
          },
        ],
      },
      searches: [],
      collection: { status: "ready", rows },
      tags,
      tagsReady: true,
    }).html;
  } else {
    home.replaceChildren();
    grid.innerHTML = rows
      .slice(0, Number(document.querySelector("#density").value))
      .map((row, i) =>
        collectionCard(
          mode === "catalog" ? { card } : row,
          i,
          mode === "deck" ? tags[0] : null,
        ),
      )
      .join("");
  }
  home.querySelector("#clear-home-history")?.addEventListener("click", () => {
    status.textContent =
      "Prototype: recent sample cards cleared for this session.";
    home.querySelector(".home-cards").replaceChildren();
  });
}
document.querySelector("#surface").onchange = render;
document.querySelector("#density").onchange = render;
document.querySelector("#renderer").value =
  new URL(location.href).searchParams.get("renderer") === "webgl"
    ? "webgl"
    : "svg";
document.querySelector("#renderer").onchange = () => gestures.cancel();
render();
