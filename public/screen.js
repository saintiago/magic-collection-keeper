export function routeMode(hash) {
  if (hash.startsWith("#review=")) return "import";
  if (hash.startsWith("#card=")) return "card";
  return hash.startsWith("#tag=") || hash === "#collection"
    ? "collection"
    : hash === "#catalog"
      ? "catalog"
      : hash === "#import" || hash.startsWith("#import=")
        ? "import"
        : "home";
}
export function showScreen(mode) {
  const $ = (id) => document.getElementById(id),
    home = mode === "home",
    collection = mode === "collection",
    importing = mode === "import";
  document.body.dataset.mode = mode;
  $("title").textContent = {
    home: "Home",
    collection: "My collection",
    catalog: "All cards",
    import: "Import",
    card: "Card",
  }[mode];
  $("home-page").hidden = !home;
  $("detail").hidden = mode !== "card";
  $("import-page").hidden = !importing;
  $("shared-search").hidden = importing;
  $("search-help").hidden = home || mode === "card";
  document.querySelector(".library").hidden =
    home || importing || mode === "card";
  $("stats").hidden = !collection;
  $("filters").hidden = !collection;
  $("refresh").hidden = !collection;
  $("add").hidden = !collection;
  $("catalog-nav").hidden = !collection;
  for (const id of ["scan", "import-nav", "manage-tags"])
    $(id).hidden = importing;
  $("collection-nav").classList.toggle("active", collection);
  $("collection-nav").setAttribute(
    "aria-current",
    collection ? "page" : "false",
  );
  $("home-nav").setAttribute("aria-current", home ? "page" : "false");
  $("section-title").firstChild.textContent = collection
    ? "Your library "
    : "Card catalog ";
}
