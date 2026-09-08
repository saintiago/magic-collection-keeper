import { esc } from "./view.js";

// Owns one visible selection; navigation and private collection state are ports.
export function createCardPage({
  root,
  enter,
  load,
  renderDetail,
  onOpened,
  back,
}) {
  let generation = 0,
    controller,
    current,
    resolvedRow;
  const content = root.querySelector("#detail-content"),
    heading = root.querySelector("#card-heading"),
    status = root.querySelector("#card-status");
  const metric = (phase, start, extra = {}) =>
    window.dispatchEvent(
      new CustomEvent("keeper-card-metric", {
        detail: { phase, ms: performance.now() - start, ...extra },
      }),
    );
  function hide() {
    generation++;
    controller?.abort();
    current = null;
    resolvedRow = null;
    content.replaceChildren();
    root.hidden = true;
  }
  async function open(item, options = {}) {
    const started = performance.now(),
      token = ++generation;
    controller?.abort();
    controller = new AbortController();
    const row = item.card ? item : null;
    const ref = row
      ? {
          printing_id: row.card.id,
          oracle_id: row.card.oracle_id,
          entry: row.id ? String(row.id) : "",
          lang: row.card.lang,
          name: row.card.name,
        }
      : item;
    current = ref;
    resolvedRow = null;
    enter(ref, options);
    root.hidden = false;
    root.setAttribute("aria-busy", "true");
    heading.textContent = ref.name || "Card details";
    content.replaceChildren();
    status.textContent = ref.invalid
      ? "This card link is invalid. Go back and choose a card again."
      : `Opening ${ref.name || "card"}…`;
    status.className = ref.invalid ? "error" : "";
    heading.focus({ preventScroll: true });
    root.scrollIntoView({ block: "start" });
    metric("page-visible", started);
    if (ref.invalid) {
      root.setAttribute("aria-busy", "false");
      return;
    }
    try {
      const resolved =
        row ||
        (await load(
          ref,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        ));
      if (token !== generation) return;
      resolvedRow = resolved;
      heading.textContent = resolved.card.name;
      status.textContent = "";
      renderDetail(resolved);
      onOpened(resolved.card);
      metric("details-visible", started, {
        source: row ? "known-card" : resolved.source || "network",
      });
      const img = content.querySelector(".detail-image img");
      if (img) {
        const loaded = () => {
          if (token === generation)
            metric("image-ready", started, { available: img.naturalWidth > 0 });
        };
        if (img.complete) loaded();
        else {
          img.addEventListener("load", loaded, { once: true });
          img.addEventListener("error", loaded, { once: true });
        }
      }
    } catch (error) {
      if (token !== generation) return;
      status.className = "error";
      status.innerHTML = `${esc(error.message)} <button type="button" class="secondary">Retry opening card</button>`;
      status.querySelector("button").onclick = () =>
        open(ref, { restore: true });
    } finally {
      if (token === generation) root.setAttribute("aria-busy", "false");
    }
  }
  root.querySelector("#close").onclick = back;
  window.addEventListener("keeper-sign-out", hide);
  return {
    open,
    hide,
    refreshOwned(rows) {
      if (!resolvedRow || root.hidden) return;
      const row = resolvedRow.id
        ? rows.find((row) => row.id === resolvedRow.id)
        : resolvedRow;
      if (row) {
        resolvedRow = row;
        renderDetail(row);
      }
    },
    get current() {
      return current;
    },
  };
}
