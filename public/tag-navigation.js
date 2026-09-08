export function tagHref(id) {
  return id ? `#tag=${encodeURIComponent(id)}` : "#";
}
export function tagFromHash(hash) {
  return new URLSearchParams(hash.replace(/^#/, "")).get("tag") || "";
}
export function setupTagNavigation(onNavigate) {
  let lastHash = location.hash;
  function go(id, tag) {
    const href = tagHref(id);
    if (location.hash !== href && !(href === "#" && !location.hash))
      history.pushState(null, "", href);
    lastHash = location.hash;
    onNavigate(id, tag);
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-tag-id]");
    if (
      !link ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    go(link.dataset.tagId, {
      id: link.dataset.tagId,
      label: link.dataset.tagLabel,
      type: link.dataset.tagType,
      kind: link.dataset.tagKind,
    });
  });
  const restore = () => {
    if (lastHash === location.hash) return;
    lastHash = location.hash;
    onNavigate(tagFromHash(location.hash));
  };
  window.addEventListener("popstate", restore);
  window.addEventListener("hashchange", restore);
  return { go };
}
