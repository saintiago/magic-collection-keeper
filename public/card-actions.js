import { createArtworkViewer } from "./artwork-viewer.js";
import { createCardGestures } from "./card-gestures.js";
import { createCardActionSave } from "./card-action-save.js";
import { createCardTagActions } from "./card-tag-actions.js";

// Browser composition: gestures hold descriptors; only deliberate actions call I/O.
export function createCardActions({
  request,
  currentView,
  onOwned,
  onPending,
  getState,
  home,
  importPage,
  cardPage,
  detail,
  editTags,
  navigateTag,
  remember,
  notify,
  onSettled,
}) {
  let accountGeneration = 0;
  const cardActionSave = createCardActionSave({
    api: request,
    currentView: () => currentView(),
    onOwned: (rows) => onOwned(rows),
    onPending: (id) => onPending(id),
    onDraft: (result) => importPage.receiveDraft?.(result),
    onSaved: (result, intent) => artworkViewer.reconcile(result, intent),
    onUsed: (id) => home.tag(id),
    notify,
  });
  const tagActions = createCardTagActions({
    api: request,
    save: (intent) => cardActionSave.save(intent),
    tags: () => getState().filterTags,
  });
  function cardActionSource(target) {
    const found = rawCardActionSource(target);
    if (found) tagActions.decorate(found.item);
    return found;
  }
  function rawCardActionSource(target) {
    const { visibleCards, mode, filterTags, activeTagId } = getState();
    if (target.closest("#grid")) {
      const card = target.closest(".card"),
        button = card?.querySelector(".card-open");
      if (!button || target.closest("a[data-tag-id]")) return null;
      const row = visibleCards[Number(button.dataset.index)];
      if (!row) return null;
      return {
        element: button,
        item: {
          kind: row.id ? "owned" : "catalog",
          row,
          card: row.card,
          sourceTag:
            mode === "collection" &&
            filterTags.find((tag) => tag.id === activeTagId)?.type ===
              "location"
              ? activeTagId
              : null,
        },
      };
    }
    if (target.closest("#home-page")) return home.cardAction(target);
    if (target.closest("#import-page")) return importPage.cardAction(target);
    if (target.closest(".detail-artwork")) {
      const row = cardPage.currentRow,
        element = document.querySelector(".detail-artwork");
      if (row && element)
        return {
          element,
          item: { kind: row.id ? "owned" : "catalog", row, card: row.card },
        };
    }
    return null;
  }
  async function handleCardAction(item, tag, element) {
    const { mode } = getState();
    if (typeof tag.selected === "boolean") {
      try {
        await tagActions.toggle(item, tag, tag.selected, tag.quantity || 1);
      } catch (error) {
        if (error.name !== "AbortError") notify(error.message, true);
      }
      return;
    }
    if (item.kind === "pending") {
      const saved = await importPage.cardActionApply(item, tag);
      if (saved && !tag.action) home.tag(tag.id);
      return saved;
    }
    if (tag.action === "details") {
      if (mode === "card" && cardPage.currentRow?.card.id === item.card.id)
        return;
      if (item.ref) return cardPage.open(item.ref, { focus: element });
      if (item.kind === "catalog")
        remember({ ...item.card, printing_id: item.card.id });
      return detail(item.row || { card: item.card }, { focus: element });
    }
    if (tag.action === "edit" && item.kind === "owned")
      return editTags(item.row);
    if (item.kind === "owned")
      return cardActionSave.save({
        kind: "owned",
        tag: tag.id,
        payload: {
          operation_id: crypto.randomUUID(),
          inventory_id: String(item.row.id),
          tag_id: tag.id,
          from_tag_id: item.sourceTag || null,
          quantity: 1,
        },
      });
    const turn = currentView();
    let card = item.card;
    try {
      if (item.kind === "reference") {
        const query = new URLSearchParams({
          q: card.name,
          oracle: item.ref.oracle_id,
          printing: item.ref.printing_id,
        });
        const data = await request("/api/discover?" + query);
        if (turn !== currentView()) return;
        card = data.cards.find(
          (card) =>
            card.id === item.ref.printing_id &&
            card.oracle_id === item.ref.oracle_id,
        );
        if (!card)
          throw Error(
            "This printing could not be verified. Open its card page and try again.",
          );
      }
      await cardActionSave.save({
        kind: "catalog",
        tag: tag.action ? null : tag.id,
        payload: {
          id: crypto.randomUUID(),
          kind: "catalog",
          ...(tag.action ? {} : { tag_id: tag.id }),
          rows: [
            {
              id: crypto.randomUUID(),
              name: card.name,
              printing_id: card.id,
              quantity: 1,
              finish: card.finishes.includes("nonfoil")
                ? "nonfoil"
                : card.finishes[0],
              condition: "UNK",
            },
          ],
        },
      });
    } catch (error) {
      if (turn === currentView()) notify(error.message, true);
    }
  }
  const artworkViewer = createArtworkViewer({
    tags: () => getState().filterTags,
    recent: () => home.recentTags,
    loadTags: (item) => tagActions.load(item),
    onToggle: (...args) => tagActions.toggle(...args),
    onOpened: (card) => home.card(card),
  });
  const cardGestures = createCardGestures({
    resolve: cardActionSource,
    tags: () => getState().filterTags,
    recent: () => home.recentTags,
    viewer: artworkViewer,
    onAction: handleCardAction,
    onSettled,
  });

  return {
    get holding() {
      return cardGestures.holding;
    },
    start(account) {
      accountGeneration++;
      cardActionSave.start(account);
      tagActions.start(account);
    },
    stop() {
      accountGeneration++;
      cardActionSave.stop();
      tagActions.stop();
      cardGestures.cancel();
    },
    cancel: cardGestures.cancel,
  };
}
