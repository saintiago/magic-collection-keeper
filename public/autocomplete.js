import { esc } from "./view.js";

export function setupAutocomplete({
  input,
  panel,
  api,
  onSelect,
  onQueryChange,
  delay = 180,
}) {
  let enabled = false,
    timer,
    generation = 0,
    controller,
    items = [],
    selected = -1,
    composing = false,
    version = null;
  const cache = new Map();
  function close() {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    items = [];
    selected = -1;
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function draw(message = "") {
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    panel.innerHTML = `<div id="card-suggestions" role="listbox" aria-label="Card name suggestions">${items.map((item, i) => `<div id="card-suggestion-${i}" role="option" aria-selected="${selected === i}" data-suggestion="${i}"><b>${esc(item.name)}</b>${item.matched_name ? `<small>${esc(item.matched_name)} · ${esc(item.matched_language.toUpperCase())}</small>` : ""}</div>`).join("")}</div><p role="status" aria-live="polite">${esc(message || `${items.length} suggestions. Use arrow keys to choose.`)}</p>`;
    if (selected >= 0)
      input.setAttribute(
        "aria-activedescendant",
        `card-suggestion-${selected}`,
      );
    else input.removeAttribute("aria-activedescendant");
  }
  function choose(i) {
    const item = items[i];
    if (!item) return;
    close();
    input.value = item.name;
    onSelect(item);
  }
  function change() {
    if (!enabled || composing) return;
    close();
    onQueryChange();
    const query = input.value.trim(),
      turn = generation;
    if (
      !query ||
      (query.length < 2 &&
        !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          query,
        )) ||
      query.includes(":")
    )
      return;
    timer = setTimeout(async () => {
      controller = new AbortController();
      draw("Finding card names…");
      try {
        const saved = cache.get(query);
        const result =
          saved && Date.now() - saved.at < 86400000
            ? saved.data
            : await api(`/api/suggest?${new URLSearchParams({ q: query })}`, {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(20000),
                ]),
              });
        if (
          turn !== generation ||
          input.value.trim() !== query ||
          document.activeElement !== input
        )
          return;
        if (result.catalog?.version && version !== result.catalog.version) {
          cache.clear();
          version = result.catalog.version;
        }
        if (cache.size >= 50) cache.delete(cache.keys().next().value);
        cache.set(query, { at: Date.now(), data: result });
        items = result.suggestions;
        draw(
          items.length
            ? result.catalog?.stale
              ? "Names may be out of date; the last catalog is shown."
              : ""
            : "No matching names. Try another spelling or search.",
        );
      } catch (error) {
        if (turn === generation)
          draw(
            "Suggestions unavailable. Edit the name to retry, or use Search cards.",
          );
      }
    }, delay);
  }
  input.addEventListener("input", change);
  input.addEventListener("compositionstart", () => {
    composing = true;
    close();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    change();
  });
  input.addEventListener("keydown", (event) => {
    if (!enabled || event.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key) && items.length) {
      event.preventDefault();
      selected =
        (selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
        items.length;
      draw();
      panel
        .querySelector(`[data-suggestion="${selected}"]`)
        .scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && selected >= 0) {
      event.preventDefault();
      choose(selected);
    } else if (["Escape", "Tab", "Enter"].includes(event.key)) close();
  });
  input.addEventListener("blur", close);
  panel.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-suggestion]")) event.preventDefault();
  });
  panel.addEventListener("click", (event) => {
    const option = event.target.closest("[data-suggestion]");
    if (option) choose(Number(option.dataset.suggestion));
  });
  return {
    close,
    setEnabled(value) {
      close();
      enabled = value;
      if (value) {
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-controls", "card-suggestions");
      } else
        ["role", "aria-autocomplete", "aria-controls", "aria-expanded"].forEach(
          (name) => input.removeAttribute(name),
        );
    },
  };
}
