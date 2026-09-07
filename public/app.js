import { signIn } from "./auth.js";
import { api } from "./api.js";
import { esc, finishName, picture } from "./view.js";
import { createCardDetail } from "./card-detail.js";
import { setupBatch } from "./batch.js";
const $ = (id) => document.getElementById(id);
let owned = [],
  cards = [],
  mode = "collection",
  page = 1,
  query = "",
  hasMore = false,
  loading = false,
  requestId = 0;
const detail = createCardDetail({
  api,
  onSaved: (updated) => {
    owned = updated;
    render();
  },
  notify: message,
});
function message(text = "", error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
}
function stats() {
  $("total").textContent = owned
    .reduce((n, r) => n + r.quantity, 0)
    .toLocaleString();
  $("nav-count").textContent = $("total").textContent;
  $("unique").textContent = new Set(owned.map((r) => r.printing_id)).size;
  $("sets").textContent = new Set(owned.map((r) => r.card.set)).size;
  $("foils").textContent = owned
    .filter((r) => r.finish !== "nonfoil")
    .reduce((n, r) => n + r.quantity, 0);
  const selected = $("set-filter").value;
  const sets = [
    ...new Map(owned.map((r) => [r.card.set, r.card.set_name])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  $("set-filter").innerHTML =
    '<option value="">All sets</option>' +
    sets
      .map(
        ([code, name]) => `<option value="${esc(code)}">${esc(name)}</option>`,
      )
      .join("");
  $("set-filter").value = sets.some(([code]) => code === selected)
    ? selected
    : "";
}
function render() {
  stats();
  let rows = cards.map((card) => ({ card }));
  if (mode === "collection") {
    const q = $("search").value.toLowerCase().trim(),
      color = $("color").value;
    rows = owned.filter(
      (r) =>
        `${r.card.name} ${r.card.set_name} ${r.card.set} ${r.card.collector_number} ${r.card.type_line} ${r.language} ${r.condition}`
          .toLowerCase()
          .includes(q) &&
        (!$("set-filter").value || r.card.set === $("set-filter").value) &&
        (!$("finish-filter").value || r.finish === $("finish-filter").value) &&
        (!color ||
          (color === "C"
            ? !r.card.color_identity?.length
            : r.card.color_identity?.includes(color))),
    );
    if ($("sort").value === "name")
      rows.sort((a, b) => a.card.name.localeCompare(b.card.name));
    if ($("sort").value === "quantity")
      rows.sort((a, b) => b.quantity - a.quantity);
  }
  $("result-count").textContent =
    `${rows.length} ${mode === "collection" ? "entries" : "printings shown"}`;
  $("grid").innerHTML = rows
    .map(
      (r, i) =>
        `<button class="card" data-index="${i}"><div class="card-image">${picture(r.card)}</div><div class="card-info"><div class="card-title">${esc(r.card.name)}</div><div class="card-meta">${esc(r.card.set.toUpperCase())} · #${esc(r.card.collector_number)} <span>${esc(r.card.lang.toUpperCase())}</span></div><div class="card-bottom"><span>${r.id ? esc(`${finishName[r.finish]} · ${r.condition}`) : esc(r.card.rarity)}</span><b>${r.id ? `${r.quantity} owned` : "+ Add to collection"}</b></div></div></button>`,
    )
    .join("");
  $("grid")
    .querySelectorAll(".card")
    .forEach(
      (button) =>
        (button.onclick = () => detail(rows[Number(button.dataset.index)])),
    );
  $("empty").hidden = rows.length > 0 || loading;
  $("empty").innerHTML =
    mode === "collection"
      ? owned.length
        ? '<div class="empty-icon">⌕</div><h3>No cards match these filters</h3><p>Try another name, color, set, or finish.</p><button class="secondary" id="clear-filters">Clear filters</button>'
        : '<div class="empty-icon">✦</div><div class="eyebrow">A FRESH PAGE</div><h3>Your collection begins here</h3><p>From your first common to your favorite rare.<br>Find a card, choose its printing, and make it yours.</p><button class="primary" id="first-card">+ Find your first card</button><small>No sample cards. Just the cards you own.</small>'
      : `<div class="empty-icon">⌕</div><h3>${query ? "No printings found" : "Find your next addition"}</h3><p>${query ? "Try a different spelling or set code." : "Search Magic’s card catalog by name, set, or collector number."}</p>`;
  if ($("first-card")) $("first-card").onclick = () => switchMode("catalog");
  if ($("clear-filters"))
    $("clear-filters").onclick = () => {
      ["search", "color", "set-filter", "finish-filter"].forEach(
        (id) => ($(id).value = ""),
      );
      render();
    };
  $("more").hidden = mode !== "catalog" || !hasMore;
  $("more").disabled = loading;
}
function switchMode(next) {
  mode = next;
  requestId++;
  loading = false;
  $("search-submit").disabled = false;
  message();
  $("search").value = "";
  cards = [];
  query = "";
  hasMore = false;
  const catalog = mode === "catalog";
  $("title").innerHTML = catalog
    ? "Discover cards<span>.</span>"
    : "My collection<span>.</span>";
  $("subtitle").textContent = catalog
    ? "Find the right card. Keep the exact printing."
    : "Your cards, thoughtfully kept. Build a collection you know by heart.";
  $("breadcrumb").textContent = catalog ? "Discover cards" : "My collection";
  $("section-title").firstChild.textContent = catalog
    ? "Card catalog "
    : "Your library ";
  $("stats").hidden = catalog;
  $("filters").hidden = catalog;
  $("search-submit").hidden = !catalog;
  $("search-help").hidden = !catalog;
  $("search").placeholder = catalog
    ? "Card name, set:blb cn:1, or another Scryfall query…"
    : "Search your collection…";
  $("catalog-nav").classList.toggle("active", catalog);
  $("collection-nav").classList.toggle("active", !catalog);
  $("add").hidden = catalog;
  $("refresh").hidden = catalog;
  render();
  $("search").focus();
}
async function refresh() {
  $("refresh").disabled = true;
  message("Updating your collection…");
  try {
    owned = await api("/api/collection");
    render();
    message("Collection is up to date. All saved changes loaded.");
  } catch (e) {
    message(e.message, true);
  } finally {
    $("refresh").disabled = false;
  }
}
async function search(more = false) {
  const nextQuery = $("search").value.trim();
  if (!nextQuery) {
    message("Enter a card name or a set and collector number.", true);
    return;
  }
  const token = ++requestId;
  const nextPage = more ? page + 1 : 1;
  if (!more) {
    query = nextQuery;
    cards = [];
    hasMore = false;
  }
  loading = true;
  message("Searching Scryfall for matching printings…");
  $("search-submit").disabled = true;
  render();
  try {
    const data = await api(
      `/api/search?${new URLSearchParams({ q: query, page: nextPage })}`,
    );
    if (token !== requestId) return;
    cards = more ? [...cards, ...data.cards] : data.cards;
    page = nextPage;
    hasMore = data.hasMore;
    message(
      `${data.total.toLocaleString()} matching printings in the catalog. Select a card to review and add it.`,
    );
  } catch (e) {
    if (token === requestId) message(e.message, true);
  } finally {
    if (token === requestId) {
      loading = false;
      $("search-submit").disabled = false;
      render();
    }
  }
}
$("collection-nav").onclick = () => switchMode("collection");
$("catalog-nav").onclick = () => switchMode("catalog");
$("add").onclick = () => switchMode("catalog");
$("close").onclick = () => $("detail").close();
$("refresh").onclick = refresh;
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  if (mode === "catalog") search();
};
$("search").oninput = () => {
  if (mode === "collection") render();
};
["color", "set-filter", "finish-filter", "sort"].forEach(
  (id) => ($(id).onchange = render),
);
$("more").onclick = () => search(true);
$("example").onclick = () => {
  $("search").value = "set:blb cn:1";
  search();
};
render();
await signIn();
setupBatch({
  api,
  onSaved: async () => {
    owned = await api("/api/collection");
    render();
  },
});
refresh();
