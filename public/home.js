import { createHomeHistory } from "./home-history.js";
import { homeContent } from "./home-view.js";
import { image } from "./view.js";
export function createHome({ root, onCard, onClearSearches, onRetry }) {
  let inputs = {
      searches: [],
      collection: { rows: null, status: "loading" },
      tags: [],
      tagsReady: false,
    },
    cards = [];
  const history = createHomeHistory({ onChange: render });
  function cardEntry(card) {
    return {
      kind: "card",
      name: card.name,
      printing_id: card.id || card.printing_id,
      oracle_id: card.oracle_id,
      image_url: image(card) || card.image_url,
    };
  }
  function render() {
    if (root.querySelector(".artwork-source-lifted,.card-wheel-source")) return;
    const focused =
      document.activeElement?.closest(".home-card")?.dataset.cardKey;
    if (root.hidden) {
      root.replaceChildren();
      return;
    }
    const view = homeContent({ ...inputs, activity: history.state });
    cards = view.cards;
    root.innerHTML = view.html;
    if (focused)
      root
        .querySelector(`[data-card-key="${CSS.escape(focused)}"] button`)
        ?.focus({ preventScroll: true });
  }
  window.addEventListener("keeper-artwork-closed", render);
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-home-card]");
    if (button) onCard(cards[Number(button.dataset.homeCard)]);
    if (event.target.closest("#clear-home-history")) {
      history.clear();
      if (!history.state.error) onClearSearches();
    }
    if (event.target.closest("#home-retry")) onRetry();
  });
  return {
    update(next) {
      inputs = { ...inputs, ...next };
      render();
    },
    start: (key) => history.start(key),
    stop() {
      inputs = {
        searches: [],
        collection: { rows: null, status: "loading" },
        tags: [],
        tagsReady: false,
      };
      history.stop();
    },
    unavailable: () => history.unavailable(),
    card(card) {
      history.remember(cardEntry(card));
    },
    enrich: (card) => history.enrich(cardEntry(card)),
    tag: (id) => history.remember({ kind: "tag", id }),
    get recentTags() {
      return history.state.entries
        .filter((item) => item.kind === "tag")
        .map((item) => item.id);
    },
    cardAction(element) {
      const button = element
        .closest(".home-card")
        ?.querySelector("[data-home-card]");
      if (element.closest("a[data-tag-id]")) return null;
      if (!button) return null;
      const ref = cards[Number(button.dataset.homeCard)];
      if (!ref) return null;
      const row = (inputs.collection.rows || []).find(
        (row) => row.printing_id === ref.printing_id,
      );
      return {
        element: button,
        item: row
          ? { kind: "owned", row, card: row.card }
          : {
              kind: "reference",
              ref,
              card: {
                ...ref,
                id: ref.printing_id,
                image_uris: { normal: ref.image_url },
              },
            },
      };
    },
  };
}
