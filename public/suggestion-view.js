import { esc } from "./view.js";

export function suggestionPanel(
  items,
  selected,
  { recent = false, message = "" } = {},
) {
  const options = items
    .map((item, i) => {
      const alias =
        !recent &&
        item.matched_name &&
        item.matched_language &&
        item.matched_language !== "en"
          ? `<small class="suggestion-alias">${esc(item.matched_name)} · ${esc(item.matched_language.toUpperCase())}</small>`
          : "";
      return `<div id="card-suggestion-${i}" role="option" aria-selected="${selected === i}" data-suggestion="${i}"><div class="suggestion-name"><b>${esc(item.name)}</b>${item.kind === "query" ? "" : '<span class="suggestion-ownership" role="img"></span>'}</div>${alias}${item.kind === "query" ? "<small>Run this search again</small>" : ""}</div>`;
    })
    .join("");
  return `${recent ? '<p class="recent-heading">Recent searches</p>' : ""}<div id="card-suggestions" role="listbox" aria-label="${recent ? "Recent searches" : "Card name suggestions"}">${options}</div><p role="status" aria-live="polite">${esc(message || `${items.length} suggestions. Use arrow keys to choose.`)}</p>`;
}
