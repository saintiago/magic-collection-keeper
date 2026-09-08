import { createTagController, tagBadges, allocationWarning } from "./tags.js";
import { createCollectionLoader } from "./collection-loader.js";
import { snapshotKey, snapshotStore } from "./collection-cache.js";
import { setupReleaseInfo } from "./release-info.js";
import { signIn, collectionIdentity } from "./auth.js";
import { api as request } from "./api.js";
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
let collectionState = {
  rows: null,
  status: "loading",
  savedAt: null,
  error: "",
};
const collection = createCollectionLoader({
  load: () => api("/api/collection"),
  cache: snapshotStore,
  onChange: (state) => {
    collectionState = state;
    owned = state.rows || [];
    render();
  },
});
window.addEventListener("keeper-sign-out", () => collection.stop());
const tagController = createTagController({
  api,
  onChanged: () => {
    collection.invalidate();
    return refresh();
  },
});
const detail = createCardDetail({
  onTags: (row) => {
    document.getElementById("detail").close();
    tagController.edit(row);
  },
  api,
  onSaved: (updated) => {
    if (collectionState.rows !== updated) collection.replace(updated);
  },
  notify: message,
});
async function api(path, options) {
  const mutation = options?.method && options.method !== "GET";
  if (mutation) collection.invalidate();
  const result = await request(path, options);
  if (mutation) {
    collection.invalidate();
    if (path.startsWith("/api/collection") && Array.isArray(result))
      collection.replace(result);
  }
  return result;
}
function message(text = "", error = false) {
  $("message").textContent = text;
  $("message").className = error ? "error" : "";
}
function stats() {
  if (collectionState.rows === null) {
    ["total", "nav-count", "unique", "sets", "foils"].forEach(
      (id) => ($(id).textContent = "—"),
    );
    return;
  }
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
  const known = collectionState.rows !== null;
  const busy = ["loading", "updating"].includes(collectionState.status);
  $("refresh").disabled = busy;
  $("collection-status").hidden = mode !== "collection";
  const freshness = collectionState.savedAt
    ? new Date(collectionState.savedAt).toLocaleString()
    : "";
  $("collection-status-text").textContent = busy
    ? known
      ? "Showing saved snapshot from " +
        freshness +
        ". Updating your collection…"
      : "Loading your collection…"
    : collectionState.status === "error"
      ? known
        ? "Showing saved snapshot from " +
          freshness +
          ". Update failed; your last saved cards remain visible."
        : "Your collection could not be loaded."
      : "Collection is up to date. Last loaded " + freshness + ".";
  $("collection-error").textContent = collectionState.error;
  $("retry-collection").hidden = collectionState.status !== "error";
  $("grid").setAttribute("aria-busy", String(busy));
  let rows = cards.map((card) => ({ card }));
  if (mode === "collection") {
    const q = $("search").value.toLowerCase().trim(),
      color = $("color").value;
    rows = owned.filter(
      (r) =>
        `${r.card.name} ${r.card.set_name} ${r.card.set} ${r.card.collector_number} ${r.card.type_line} ${r.language} ${r.condition}`
          .toLowerCase()
          .includes(q) &&
        (!$("tag-filter").value ||
          (r.locations ?? []).some((a) => a.tag_id === $("tag-filter").value) ||
          (r.tag_ids ?? []).includes($("tag-filter").value)) &&
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
    mode === "collection" && !known
      ? busy
        ? "Loading…"
        : "Unavailable"
      : `${rows.length} ${mode === "collection" ? "entries" : "printings shown"}`;
  $("grid").innerHTML = rows
    .map(
      (r, i) =>
        `<button class="card" data-index="${i}"><div class="card-image">${picture(r.card)}</div><div class="card-info"><div class="card-title">${esc(r.card.name)}</div><div class="card-meta">${esc(r.card.set.toUpperCase())} · #${esc(r.card.collector_number)} <span>${esc(r.card.lang.toUpperCase())}</span></div><div class="card-bottom"><span>${r.id ? esc(`${finishName[r.finish]} · ${r.condition}`) : esc(r.card.rarity)}</span><b>${r.id ? `${r.quantity} owned` : "+ Add to collection"}</b></div>${r.id ? `<div class="card-tags">${tagBadges(r)}</div>${allocationWarning(r)}` : ""}</div></button>`,
    )
    .join("");
  $("grid")
    .querySelectorAll(".card")
    .forEach(
      (button) =>
        (button.onclick = () => detail(rows[Number(button.dataset.index)])),
    );
  $("empty").hidden =
    rows.length > 0 || loading || (mode === "collection" && !known && busy);
  $("empty").innerHTML =
    mode === "collection"
      ? !known
        ? "<h3>Collection unavailable</h3><p>Retry to load your saved cards.</p>"
        : owned.length
          ? '<div class="empty-icon">⌕</div><h3>No cards match these filters</h3><p>Try another name, color, set, or finish.</p><button class="secondary" id="clear-filters">Clear filters</button>'
          : '<div class="empty-icon">✦</div><div class="eyebrow">A FRESH PAGE</div><h3>Your collection begins here</h3><p>From your first common to your favorite rare.<br>Find a card, choose its printing, and make it yours.</p><button class="primary" id="first-card">+ Find your first card</button><small>No sample cards. Just the cards you own.</small>'
      : `<div class="empty-icon">⌕</div><h3>${query ? "No printings found" : "Find your next addition"}</h3><p>${query ? "Try a different spelling or set code." : "Search Magic’s card catalog by name, set, or collector number."}</p>`;
  if ($("first-card")) $("first-card").onclick = () => switchMode("catalog");
  if ($("clear-filters"))
    $("clear-filters").onclick = () => {
      ["search", "color", "set-filter", "finish-filter", "tag-filter"].forEach(
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
  if (await collection.refresh()) await refreshTags();
}
async function refreshTags() {
  try {
    const tags = await tagController.refresh();
    const selected = $("tag-filter").value;
    $("tag-filter").innerHTML =
      '<option value="">All tags & locations</option>' +
      tags
        .map(
          (t) =>
            '<option value="' + esc(t.id) + '">' + esc(t.label) + "</option>",
        )
        .join("");
    $("tag-filter").value = selected;
  } catch (error) {
    message(
      "Collection loaded; tags could not be refreshed: " + error.message,
      true,
    );
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
$("refresh").onclick = initializeCollection;
$("retry-collection").onclick = initializeCollection;
$("manage-tags").onclick = () => tagController.manager();
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  if (mode === "catalog") search();
};
$("search").oninput = () => {
  if (mode === "collection") render();
};
["color", "set-filter", "finish-filter", "sort", "tag-filter"].forEach(
  (id) => ($(id).onchange = render),
);
$("more").onclick = () => search(true);
$("example").onclick = () => {
  $("search").value = "set:blb cn:1";
  search();
};
setupReleaseInfo();
render();
await signIn();
setupBatch({
  api,
  onSaved: async () => {
    if (!(await collection.refresh()))
      throw new Error(
        collectionState.error ||
          "Collection refresh was interrupted. Update collection to confirm your saved cards.",
      );
    await refreshTags();
  },
});
async function initializeCollection() {
  try {
    const identity = await collectionIdentity();
    if (collectionState.rows === null) {
      if (await collection.start(snapshotKey(identity))) await refreshTags();
    } else await refresh();
  } catch (error) {
    collectionState = {
      ...collectionState,
      status: "error",
      error: error.message,
    };
    render();
  }
}
initializeCollection();
