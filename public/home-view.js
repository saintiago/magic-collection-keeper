import { esc, image } from "./view.js";
import { tagLink } from "./tag-view.js";
import { suggestionOwnership, searchOwnership } from "./search-ownership.js";
export function homeContent({
  activity,
  searches,
  collection,
  tags,
  tagsReady,
  tagsError = "",
}) {
  if (["loading", "locked", "unavailable"].includes(activity.status))
    return {
      cards: [],
      html: `<p class="home-status" role="status">${activity.status === "loading" ? "Loading your home…" : esc(activity.error || "Sign in to see your recent activity.")}</p>`,
    };
  const own = collection.rows || [],
    ownership = searchOwnership(collection);
  const cards = [
    ...activity.entries.filter((e) => e.kind === "card"),
    ...searches.filter((e) => e.kind === "card"),
  ]
    .filter(
      (e, i, all) =>
        all.findIndex(
          (other) =>
            (other.oracle_id || other.printing_id) ===
            (e.oracle_id || e.printing_id),
        ) === i,
    )
    .slice(0, 6);
  const recentTags = activity.entries
    .filter((e) => e.kind === "tag")
    .map((e) => tags.find((t) => t.id === e.id))
    .filter(Boolean);
  function group(deck) {
    const match = (t) => (t.type === "location" && t.kind === "deck") === deck;
    const recent = recentTags.filter(match);
    const chosen = (recent.length ? recent : tags.filter(match)).slice(0, 4);
    const heading = `${recent.length ? "Recent" : "Your"} ${deck ? "decks" : "tags"}`;
    return `<section class="home-group" aria-label="${heading}"><h2>${heading}</h2><div class="${deck ? "home-decks" : "home-tags"}">${chosen.map((t) => tagLink(t)).join("")}</div>${chosen.length ? "" : `<p class="home-empty">${!tagsReady ? "Loading your tags…" : tagsError ? "Tags unavailable." : deck ? "No decks yet. Create a deck in Tags & locations." : "No tags yet. Organize a card to get started."}</p>`}</section>`;
  }
  const status =
    collection.status === "error"
      ? "Collection update failed. Saved ownership may be out of date."
      : collection.status !== "ready"
        ? "Updating your collection…"
        : "";
  return {
    cards,
    html: `<div class="home-section-heading"><h2>Recent cards</h2><button class="text-button" id="clear-home-history" ${activity.entries.length || searches.length ? "" : "hidden"}>Clear activity</button></div><div class="home-cards">${cards
      .map((item, i) => {
        const row =
          own.find((r) => r.printing_id === item.printing_id) ||
          own.find(
            (r) => item.oracle_id && r.card.oracle_id === item.oracle_id,
          );
        const source = row ? image(row.card) : item.image_url;
        const badge = suggestionOwnership(item, ownership);
        return `<button class="home-card" data-home-card="${i}">${source ? `<img src="${esc(source)}" alt="" loading="lazy">` : '<span class="home-card-placeholder" aria-hidden="true">✦</span>'}<span class="home-card-name">${esc(item.name)} <span role="img" aria-label="${esc(badge.label)}" title="${esc(badge.label)}">${badge.icon}</span></span></button>`;
      })
      .join(
        "",
      )}</div>${cards.length ? "" : '<p class="home-empty">Cards you open will appear here.</p>'}<div class="home-organized">${group(true)}${group(false)}</div><p class="home-status" role="status">${esc(activity.error || tagsError || status)}</p>${collection.status === "error" || tagsError ? '<button class="secondary" id="home-retry">Retry collection</button>' : ""}`,
  };
}
