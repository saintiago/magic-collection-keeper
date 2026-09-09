import { cardHref } from "./card-route.js";

// View snapshots stay in memory; history contains an opaque key, never inventory.
export function createCardNavigation({
  capture,
  restore,
  home,
  sync,
  beforeBack,
  onRestored,
}) {
  const views = new Map();
  function enter(
    ref,
    { restore: restoring = false, replace = false, focus } = {},
  ) {
    if (restoring) return;
    if (!location.hash.startsWith("#card=")) {
      const key = crypto.randomUUID();
      if (views.size >= 20) views.delete(views.keys().next().value);
      views.set(key, {
        ...capture(),
        focus:
          focus ||
          (document.activeElement === document.body
            ? document.getElementById("search")
            : document.activeElement),
        scroll: scrollY,
      });
      history.replaceState({ keeperView: key }, "");
    }
    history[replace ? "replaceState" : "pushState"](
      { keeperCard: true },
      "",
      typeof ref === "string" ? ref : cardHref(ref),
    );
    sync();
  }
  function restoreView() {
    const view = views.get(history.state?.keeperView);
    if (!view) return false;
    restore(view);
    {
      const focus = view.focus?.isConnected
        ? view.focus
        : document.getElementById(view.focus?.id) ||
          document.querySelector(
            view.focus?.dataset.index
              ? `.card-open[data-index="${Number(view.focus.dataset.index)}"]`
              : "#section-title",
          );
      focus?.focus({ preventScroll: true });
      scrollTo(0, view.scroll);
    }
    onRestored();
    return true;
  }
  window.addEventListener("keeper-sign-out", () => views.clear());
  return {
    enter,
    restoreView,
    back: () => {
      beforeBack();
      if (history.state?.keeperCard) history.back();
      else home();
    },
  };
}
