import { esc } from "./view.js";
import { suggestionOwnership } from "./search-ownership.js";

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
    touch = null,
    ownership = null,
    recent = { entries: [], status: "loading", error: "" },
    showingRecent = false,
    version = null;
  const cache = new Map();
  function close() {
    touch = null;
    generation++;
    clearTimeout(timer);
    controller?.abort();
    items = [];
    selected = -1;
    panel.hidden = true;
    panel.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function draw(message = "") {
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    panel.innerHTML = `${showingRecent ? '<p class="recent-heading">Recent searches</p>' : ""}<div id="card-suggestions" role="listbox" aria-label="${showingRecent ? "Recent searches" : "Card name suggestions"}">${items.map((item, i) => `<div id="card-suggestion-${i}" role="option" aria-selected="${selected === i}" data-suggestion="${i}"><b>${esc(item.name)}</b>${item.matched_name ? `<small>${esc(item.matched_name)} · ${esc(item.matched_language.toUpperCase())}</small>` : ""}<small class="suggestion-ownership"></small></div>`).join("")}</div><p role="status" aria-live="polite">${esc(message || `${items.length} suggestions. Use arrow keys to choose.`)}</p>`;
    updateOwnership(ownership);
    if (selected >= 0)
      input.setAttribute(
        "aria-activedescendant",
        `card-suggestion-${selected}`,
      );
    else input.removeAttribute("aria-activedescendant");
  }
  function updateOwnership(next) {
    ownership = next;
    // Update text in place: a collection response must not replace the option under a finger.
    panel.querySelectorAll("[data-suggestion]").forEach((option) => {
      const item = items[Number(option.dataset.suggestion)];
      if (!item) return;
      const badge =
        item.kind === "query"
          ? { text: "Run this search again", owned: false }
          : suggestionOwnership(item, ownership);
      const label = option.querySelector(".suggestion-ownership");
      label.textContent = `${badge.owned ? "✓ " : ""}${badge.text}`;
      label.classList.toggle("is-owned", badge.owned);
    });
  }
  function showRecent() {
    if (!enabled || input.value.trim() || recent.status === "locked") return;
    close();
    showingRecent = true;
    items = recent.entries;
    draw(
      recent.error ||
        (recent.status === "loading"
          ? "Loading recent searches…"
          : items.length
            ? "Choose a recent card or search."
            : "No recent searches yet. Search or choose a card to start."),
    );
  }
  function updateRecent(next) {
    recent = next;
    if (recent.status === "locked") {
      close();
      return;
    }
    if (!touch && document.activeElement === input && !input.value.trim())
      showRecent();
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
    if (!query) {
      showRecent();
      return;
    }
    showingRecent = false;
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
          saved && Date.now() - saved.at < 300000
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
  input.addEventListener("focus", () => {
    if (!input.value.trim()) showRecent();
  });
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
  input.addEventListener("blur", () => {
    // A phone can dismiss its keyboard before the finger is released.
    if (!touch) close();
  });
  panel.addEventListener("pointerdown", (event) => {
    const option = event.target.closest("[data-suggestion]");
    if (!option) return;
    if (event.pointerType === "touch") touch = { option };
    else event.preventDefault();
  });
  panel.addEventListener(
    "touchstart",
    (event) => {
      const option = event.target.closest("[data-suggestion]");
      const point = event.touches[0];
      touch =
        option && event.touches.length === 1
          ? {
              option,
              id: point.identifier,
              x: point.clientX,
              y: point.clientY,
              moved: false,
            }
          : null;
    },
    { passive: true },
  );
  panel.addEventListener(
    "touchmove",
    (event) => {
      if (!touch) return;
      const point = [...event.touches].find(
        (point) => point.identifier === touch.id,
      );
      if (
        !point ||
        Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10
      )
        touch.moved = true;
    },
    { passive: true },
  );
  panel.addEventListener(
    "scroll",
    () => {
      if (touch) touch.moved = true;
    },
    true,
  );
  panel.addEventListener("touchcancel", () => {
    touch = null;
  });
  panel.addEventListener(
    "touchend",
    (event) => {
      const pending = touch;
      touch = null;
      const point = [...event.changedTouches].find(
        (point) => point.identifier === pending?.id,
      );
      if (
        !pending ||
        pending.moved ||
        !point ||
        Math.hypot(point.clientX - pending.x, point.clientY - pending.y) > 10
      )
        return;
      // WebKit can omit a compatibility click. Commit a completed tap directly,
      // suppressing that optional click so it cannot activate content underneath.
      event.preventDefault();
      choose(Number(pending.option.dataset.suggestion));
    },
    { passive: false },
  );
  document.addEventListener("pointerdown", (event) => {
    if (
      enabled &&
      !panel.hidden &&
      event.target !== input &&
      !panel.contains(event.target)
    )
      close();
  });
  panel.addEventListener("click", (event) => {
    const option = event.target.closest("[data-suggestion]");
    if (option) choose(Number(option.dataset.suggestion));
  });
  return {
    close,
    updateOwnership,
    updateRecent,
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
