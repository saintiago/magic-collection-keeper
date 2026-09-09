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
  function render() {
    if (root.hidden) {
      root.replaceChildren();
      return;
    }
    const view = homeContent({ ...inputs, activity: history.state });
    cards = view.cards;
    root.innerHTML = view.html;
  }
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
      history.remember({
        kind: "card",
        name: card.name,
        printing_id: card.id,
        oracle_id: card.oracle_id,
        image_url: image(card),
      });
    },
    tag: (id) => history.remember({ kind: "tag", id }),
    get recentTags() {
      return history.state.entries
        .filter((item) => item.kind === "tag")
        .map((item) => item.id);
    },
    cardAction(element) {
      const button = element.closest("[data-home-card]");
      if (!button) return null;
      const ref = cards[Number(button.dataset.homeCard)];
      if (!ref) return null;
      const row =
        (inputs.collection.rows || []).find(
          (row) => row.printing_id === ref.printing_id,
        ) ||
        (inputs.collection.rows || []).find(
          (row) => row.card.oracle_id === ref.oracle_id,
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
