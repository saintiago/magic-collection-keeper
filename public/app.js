import { createCardActions } from "./card-actions.js";
import { setupAutocomplete } from "./autocomplete.js";
import { createNameClient } from "./name-client.js";
import { createCardPage } from "./card-page.js";
import { createCardNavigation } from "./card-navigation.js";
import { cardFromHash, validCardId } from "./card-route.js";
import { createDetailCache } from "./detail-cache.js";
import { searchOwnership } from "./search-ownership.js";
import { createRecentSearches } from "./recent-searches.js";
import { createHome } from "./home.js";
import { routeMode, showScreen } from "./screen.js";
import { createPrintingPicker } from "./printing-picker.js";
import { collectionCard } from "./collection-view.js";
import { setupTagNavigation, tagFromHash } from "./tag-navigation.js";
import { tagLink } from "./tag-view.js";
import {
  collectionTags,
  collectionCountText,
  displayedQuantity,
} from "./collection-counts.js";
import { createTagController } from "./tags.js";
import { createCollectionLoader } from "./collection-loader.js";
import { snapshotKey, snapshotStore } from "./collection-cache.js";
import { setupReleaseInfo } from "./release-info.js";
import { signIn, collectionIdentity } from "./auth.js";
import { api as request } from "./api.js";
import { esc } from "./view.js";
import { createCardDetail } from "./card-detail.js";
import { setupScanImport } from "./scan-import.js";
import { createImportPage } from "./import-page.js";
const $ = (id) => document.getElementById(id);
let owned = [],
  cards = [],
  mode = routeMode(location.hash),
  page = 1,
  query = "",
  hasMore = false,
  loading = false,
  requestId = 0,
  searchController;
const detailCache = createDetailCache();
let visibleCards = [],
  cardActionEpoch = 0,
  cardActions = null,
  cardRenderPending = false;
let collectionReady = Promise.resolve();
let filterTags = [],
  activeTagId = tagFromHash(location.hash),
  registryReady = false;
const tagNavigation = setupTagNavigation(navigateTag);
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
    if (state.rows !== collectionState.rows) {
      const tags = state.rows
        ? [...filterTags, ...collectionTags(state.rows)]
        : [];
      setFilterTags([...new Map(tags.map((tag) => [tag.id, tag])).values()]);
    }
    collectionState = state;
    owned = state.rows || [];
    autocomplete.updateOwnership(searchOwnership(state));
    render();
  },
});
window.addEventListener("keeper-sign-out", () => {
  cardActionEpoch++;
  cardActions.stop();
  collection.stop();
  recentSearches.stop();
  home.stop();
  autocomplete.close();
});
const tagController = createTagController({
  api,
  onUse: (id) => home.tag(id),
  onChanged: () => {
    collection.invalidate();
    return refresh().then(() => cardPage.refreshOwned(owned));
  },
});
const printingPicker = createPrintingPicker({
  api: request,
  onChoose: (card) => detail({ card }, { replace: true }),
});
const showDetail = createCardDetail({
  onAdded: (card) => home.card(card),
  loadOwned: async () => {
    await collectionReady;
    if (!(await collection.refresh()))
      throw new Error(
        "Your collection could not be refreshed. Retry to see your owned printings and tags.",
      );
    return collectionState.rows;
  },
  onPrinting: (card) => {
    printingPicker(card);
  },
  onTags: (row) => {
    tagController.edit(row);
  },
  api,
  onSaved: (updated) => {
    if (collectionState.rows !== updated) collection.replace(updated);
  },
  notify: message,
  onDone: () => cardNavigation.back(),
});
const viewControls = ["search", "color", "set-filter", "finish-filter", "sort"];
const cardNavigation = createCardNavigation({
  sync: () => tagNavigation.sync(),
  onRestored: () => autocomplete.close(),
  beforeBack: () => {
    $("search").disabled = true;
    $("close").disabled = true;
  },
  home: () => switchMode("home"),
  capture: () => ({
    mode,
    cards,
    query,
    page,
    hasMore,
    activeTagId,
    controls: Object.fromEntries(viewControls.map((id) => [id, $(id).value])),
    message: $("message").textContent,
  }),
  restore: (view) => {
    $("search").disabled = false;
    $("close").disabled = false;
    cardPage.hide();
    ({ mode, cards, query, page, hasMore, activeTagId } = view);
    for (const [id, value] of Object.entries(view.controls))
      $(id).value = value;
    autocomplete.setEnabled(mode !== "import");
    setFilterTags(filterTags);
    showScreen(mode);
    if (mode === "import") importPage.show();
    message(view.message);
    render();
  },
});
const cardPage = createCardPage({
  root: $("detail"),
  back: () => cardNavigation.back(),
  enter: (ref, options) => {
    cardActionEpoch++;
    $("search").disabled = false;
    $("close").disabled = false;
    closeCardEditors();
    cardNavigation.enter(ref, options);
    message();
    searchController?.abort();
    requestId++;
    loading = false;
    $("search-submit").disabled = false;
    autocomplete.close();
    mode = "card";
    importPage.hide();
    showScreen(mode);
    render();
  },
  renderDetail: showDetail,
  onOpened: (card, { record }) =>
    record ? home.card(card) : home.enrich(card),
  load: async (ref, signal) => {
    if (ref.entry) {
      await collectionReady;
      if (!(await collection.refresh()))
        throw Error(
          "Your collection could not be refreshed. Retry opening this entry.",
        );
      if (signal.aborted) throw signal.reason;
      const row = owned.find(
        (row) =>
          String(row.id) === ref.entry &&
          row.card.id === ref.printing_id &&
          row.card.oracle_id === ref.oracle_id,
      );
      if (!row)
        throw Error(
          "This entry is no longer in your collection. Go back to choose a card.",
        );
      return { ...row, source: "owned-entry" };
    }
    const exact = validCardId(ref.printing_id) && validCardId(ref.oracle_id);
    const params = new URLSearchParams({
      q: ref.name || "Card",
      page: "1",
      oracle: ref.oracle_id || "",
      ...(exact ? { printing: ref.printing_id } : {}),
    });
    const fetcher = () =>
      api(
        `${ref.lang && ref.lang !== "en" ? "/api/card" : "/api/discover"}?${params}`,
        { signal },
      );
    const data = exact
      ? await detailCache.load(ref.oracle_id, ref.printing_id, fetcher, signal)
      : await fetcher();
    const card = data.cards.find(
      (c) =>
        c.oracle_id === ref.oracle_id && (!exact || c.id === ref.printing_id),
    );
    if (!card)
      throw Error(
        "This card could not be verified. Go back and choose it again.",
      );
    if (data.timing)
      window.dispatchEvent(
        new CustomEvent("keeper-search-metric", { detail: data.timing }),
      );
    return {
      card,
      source:
        data.timing?.phase === "browser-detail-hit"
          ? "browser-cache"
          : "network",
    };
  },
});
function detail(row, options) {
  cardPage.open(row, options);
}
const importPage = createImportPage({
  root: $("import-page"),
  back: () => cardNavigation.back(),
  select: (id) => enterImport(id),
  api: request,
  onAdded: async () => {
    collection.invalidate();
    await refresh();
  },
});
const autocomplete = setupAutocomplete({
  names: createNameClient({ api: request }),
  input: $("search"),
  panel: $("suggestion-panel"),
  api: request,
  onSelect: (item) => {
    if (item.kind === "query") search();
    else {
      recentSearches.remember(item);
      home.card(item);
      cardPage.open(item, { remember: false });
    }
  },
  onQueryChange: () => {
    requestId++;
    searchController?.abort();
    loading = false;
    $("search-submit").disabled = false;
    hasMore = false;
    message("Choose a suggestion or search when ready.");
    render();
  },
});
const recentSearches = createRecentSearches({
  onChange: (state) => {
    $("clear-recent-searches").hidden = !state.entries.length;
    $("recent-search-message").textContent = state.error;
    autocomplete.updateRecent(state);
    home.update({ searches: state.entries });
  },
});
const home = createHome({
  root: $("home-page"),
  onClearSearches: () => recentSearches.clear(),
  onRetry: () => initializeCollection(),
  onCard: (item) => {
    const row = owned.find((row) => row.printing_id === item.printing_id);
    if (row) detail(row);
    else cardPage.open(item);
  },
});
cardActions = createCardActions({
  request,
  currentView: () => cardActionEpoch,
  onOwned: (rows) => collection.replace(rows),
  onPending: enterImport,
  getState: () => ({ visibleCards, mode, filterTags, activeTagId }),
  home,
  importPage,
  cardPage,
  detail,
  editTags: (row) => tagController.edit(row),
  navigateTag: (tag) => tagNavigation.go(tag.id, tag),
  remember: (item) => recentSearches.remember(item),
  notify: message,
  onSettled: () => {
    if (cardRenderPending && !cardActions.holding) {
      cardRenderPending = false;
      render();
    }
  },
});
$("clear-recent-searches").onclick = () => recentSearches.clear();
autocomplete.setEnabled(true);
async function api(path, options) {
  const mutation = options?.method && options.method !== "GET";
  if (mutation) collection.invalidate();
  const inventoryMutation = mutation && path.startsWith("/api/collection");
  if (inventoryMutation)
    autocomplete.updateOwnership(
      searchOwnership({ ...collectionState, status: "updating" }),
    );
  let result;
  try {
    result = await request(path, options);
  } catch (error) {
    if (inventoryMutation)
      autocomplete.updateOwnership(
        searchOwnership({ ...collectionState, status: "error" }),
      );
    throw error;
  }
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
  if (cardActions?.holding) {
    cardRenderPending = true;
    return;
  }
  cardRenderPending = false;
  stats();
  home.update({
    collection: collectionState,
    tags: filterTags,
    tagsReady: registryReady,
  });
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
  $("grid").setAttribute(
    "aria-busy",
    String(mode === "catalog" ? loading : busy),
  );
  if (mode === "home" || mode === "import" || mode === "card") {
    visibleCards = [];
    $("grid").replaceChildren();
    return;
  }
  const selectedTag = filterTags.find((tag) => tag.id === activeTagId);
  let rows = cards.map((card) => ({ card }));
  if (mode === "collection") {
    const color = $("color").value;
    rows = owned.filter(
      (r) =>
        (!activeTagId ||
          (r.locations ?? []).some((a) => a.tag_id === activeTagId) ||
          (r.tag_ids ?? []).includes(activeTagId)) &&
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
      rows.sort(
        (a, b) =>
          displayedQuantity(b, selectedTag) - displayedQuantity(a, selectedTag),
      );
  }
  $("result-count").textContent =
    mode === "collection" && !known
      ? busy
        ? "Loading…"
        : "Unavailable"
      : mode === "collection"
        ? collectionCountText(owned, rows, selectedTag)
        : `${rows.length} cards shown`;
  $("active-tag").hidden = mode !== "collection" || !activeTagId;
  $("active-tag-name").innerHTML = activeTagId
    ? tagLink(
        selectedTag || {
          id: activeTagId,
          label: registryReady ? "Tag unavailable" : "Loading tag…",
        },
      )
    : "";
  visibleCards = rows;
  $("grid").innerHTML = rows
    .map((row, index) => collectionCard(row, index, selectedTag))
    .join("");
  $("grid")
    .querySelectorAll(".card-open")
    .forEach(
      (button) =>
        (button.onclick = () => {
          const row = rows[Number(button.dataset.index)];
          if (mode === "catalog")
            recentSearches.remember({ ...row.card, printing_id: row.card.id });
          detail(row, { focus: button });
        }),
    );
  $("empty").hidden =
    rows.length > 0 || loading || (mode === "collection" && !known && busy);
  $("empty").innerHTML =
    mode === "collection"
      ? !known
        ? "<h3>Collection unavailable</h3><p>Retry to load your saved cards.</p>"
        : activeTagId && !rows.length
          ? `<h3>${!selectedTag && registryReady ? "Tag unavailable" : "No cards match this tag"}</h3><p>${!selectedTag && registryReady ? "This tag may have been deleted. Choose another tag or clear the filter." : "No saved cards match this tag and the current filters."}</p><button class="secondary" id="clear-filters">Clear filters</button>`
          : owned.length
            ? '<div class="empty-icon">⌕</div><h3>No cards match these filters</h3><p>Try another name, color, set, or finish.</p><button class="secondary" id="clear-filters">Clear filters</button>'
            : '<div class="empty-icon">✦</div><div class="eyebrow">A FRESH PAGE</div><h3>Your collection begins here</h3><p>From your first common to your favorite rare.<br>Find a card, choose its printing, and make it yours.</p><button class="primary" id="first-card">+ Find your first card</button><small>No sample cards. Just the cards you own.</small>'
      : `<div class="empty-icon">⌕</div><h3>${query ? "No cards found" : "Find your next addition"}</h3><p>${query ? "Try a different spelling or set code." : "Search Magic’s card catalog by name, set, or collector number."}</p>`;
  if ($("first-card")) $("first-card").onclick = () => switchMode("catalog");
  if ($("clear-filters"))
    $("clear-filters").onclick = () => {
      ["search", "color", "set-filter", "finish-filter", "tag-filter"].forEach(
        (id) => ($(id).value = ""),
      );
      tagNavigation.go("");
    };
  $("more").hidden = mode !== "catalog" || !hasMore;
  $("more").disabled = loading;
}
function closeCardEditors() {
  document
    .querySelectorAll(".printing-picker[open], .tag-dialog[open]")
    .forEach((dialog) => dialog.close());
}
function switchMode(next, { restore = false } = {}) {
  cardActionEpoch++;
  cardActions.cancel();
  $("search").disabled = false;
  $("close").disabled = false;
  closeCardEditors();
  cardPage.hide();
  if (!restore) {
    const hash =
      next === "collection" && activeTagId
        ? "#tag=" + encodeURIComponent(activeTagId)
        : "#" + next;
    if (location.hash !== hash) history.pushState(null, "", hash);
    tagNavigation.sync();
  }
  autocomplete.setEnabled(next !== "import");
  searchController?.abort();
  mode = next;
  requestId++;
  loading = false;
  cards = [];
  query = "";
  hasMore = false;
  $("search-submit").disabled = false;
  message();
  showScreen(mode);
  if (mode === "import") importPage.show();
  else importPage.hide();
  render();
  if (mode === "catalog") $("search").focus();
}
async function refresh() {
  if (await collection.refresh()) await refreshTags();
}
function setFilterTags(tags) {
  filterTags = tags;
  const selected = activeTagId;
  $("tag-filter").innerHTML =
    '<option value="">All tags & locations</option>' +
    tags
      .map(
        (t) =>
          '<option value="' + esc(t.id) + '">' + esc(t.label) + "</option>",
      )
      .join("");
  if (selected && !tags.some((tag) => tag.id === selected)) {
    const missing = document.createElement("option");
    missing.value = selected;
    missing.textContent = registryReady ? "Tag unavailable" : "Loading tag…";
    $("tag-filter").append(missing);
  }
  $("tag-filter").value = selected;
}
async function refreshTags() {
  try {
    const tags = await tagController.refresh();
    registryReady = true;
    home.update({ tagsError: "" });
    setFilterTags(tags);
    render();
  } catch (error) {
    registryReady = true;
    home.update({
      tagsError: "Tags could not be refreshed. Retry collection.",
    });
    setFilterTags(filterTags);
    render();
    message(
      "Collection loaded; tags could not be refreshed: " + error.message,
      true,
    );
  }
}
async function search(more = false) {
  cardActionEpoch++;
  cardActions.cancel();
  const nextQuery = $("search").value.trim();
  if (!nextQuery) {
    message("Enter a card name or a set and collector number.", true);
    return;
  }
  if (mode !== "catalog") switchMode("catalog");
  autocomplete.close();
  searchController?.abort();
  searchController = new AbortController();
  const token = ++requestId;
  const nextPage = more ? page + 1 : 1;
  if (!more) {
    query = nextQuery;
    cards = [];
    hasMore = false;
    recentSearches.remember({ kind: "query", name: query });
  }
  loading = true;
  message("Searching for matching cards…");
  $("search-submit").disabled = true;
  render();
  try {
    const signal = AbortSignal.any([
      searchController.signal,
      AbortSignal.timeout(30000),
    ]);
    const data = await api(
      `/api/discover?${new URLSearchParams({ q: query, page: nextPage })}`,
      { signal },
    );
    if (token !== requestId) return;
    if (data.timing?.phase !== "browser-detail-hit")
      detailCache.remember(data.cards);
    if (data.timing)
      window.dispatchEvent(
        new CustomEvent("keeper-search-metric", { detail: data.timing }),
      );
    cards = more ? [...cards, ...data.cards] : data.cards;
    page = nextPage;
    hasMore = data.hasMore;
    message(
      `${data.total.toLocaleString()} matching cards. English results; choose a card to review its printing.${data.catalog ? ` Names updated ${new Date(data.catalog.updated_at).toLocaleDateString()}.${data.catalog.stale ? " Catalog refresh delayed; showing the last saved names." : ""}` : ""}`,
    );
  } catch (e) {
    if (token === requestId) {
      message(e.message, true);
    }
  } finally {
    if (token === requestId) {
      loading = false;
      $("search-submit").disabled = false;
      render();
    }
  }
}
function navigateTag(id, tag) {
  cardActionEpoch++;
  cardActions.cancel();
  closeCardEditors();
  const ref = cardFromHash(location.hash);
  if (ref) {
    cardPage.open(ref, { restore: true });
    return;
  }
  cardPage.hide();
  searchController?.abort();
  requestId++;
  loading = false;
  if (!tag && cardNavigation.restoreView()) return;
  if (!id && routeMode(location.hash) !== "collection") {
    switchMode(routeMode(location.hash), { restore: true });
    return;
  }
  activeTagId = id;
  if (id) home.tag(id);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  if (tag?.id && !filterTags.some((current) => current.id === id))
    filterTags.push(tag);
  ["search", "color", "set-filter", "finish-filter"].forEach(
    (id) => ($(id).value = ""),
  );
  $("sort").value = "name";
  setFilterTags(filterTags);
  switchMode("collection", { restore: true });
  $("section-title").focus({ preventScroll: true });
  $("section-title").scrollIntoView({ block: "nearest" });
}
$("tag-filter").onchange = () => tagNavigation.go($("tag-filter").value);
$("clear-tag").onclick = () => tagNavigation.go("");
$("collection-nav").onclick = () => {
  activeTagId = "";
  setFilterTags(filterTags);
  switchMode("collection");
};
$("home-nav").onclick = (event) => {
  event.preventDefault();
  switchMode("home");
};
$("catalog-nav").onclick = () => switchMode("catalog");
$("import-nav").onclick = () => switchMode("import");
$("add").onclick = () => switchMode("catalog");
$("refresh").onclick = initializeCollection;
$("retry-collection").onclick = initializeCollection;
$("manage-tags").onclick = () => tagController.manager();
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  search();
};
["color", "set-filter", "finish-filter", "sort"].forEach(
  (id) => ($(id).onchange = render),
);
$("more").onclick = () => search(true);
$("example").onclick = () => {
  $("search").value = "set:blb cn:1";
  search();
};
setupReleaseInfo({ api });
showScreen(mode);
render();
await signIn();
if (location.hash.startsWith("#import"))
  switchMode("import", { restore: true });
function enterImport(id) {
  cardNavigation.enter(id ? "#import=" + id : "#import");
  switchMode("import", { restore: true });
}
await setupScanImport({ api, enter: enterImport, notify: message });
async function initializeCollection() {
  try {
    const identity = await collectionIdentity();
    cardActions.start(snapshotKey(identity));
    home.start(snapshotKey(identity));
    if (mode === "collection" && activeTagId) home.tag(activeTagId);
    recentSearches.start(snapshotKey(identity));
    if (collectionState.rows === null) {
      if (await collection.start(snapshotKey(identity))) await refreshTags();
    } else await refresh();
  } catch (error) {
    recentSearches.unavailable();
    home.unavailable();
    collectionState = {
      ...collectionState,
      status: "error",
      error: error.message,
    };
    render();
  }
}
collectionReady = initializeCollection();
if (cardFromHash(location.hash))
  cardPage.open(cardFromHash(location.hash), { restore: true });
