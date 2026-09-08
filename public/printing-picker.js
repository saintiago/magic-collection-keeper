import { esc, picture } from "./view.js";

// This is the exact-printing route, independent of collapsed English discovery.
export function createPrintingPicker({ api, onChoose }) {
  const dialog = document.createElement("dialog");
  dialog.className = "printing-picker";
  document.body.append(dialog);
  let generation = 0,
    controller;
  const close = () => {
    generation++;
    controller?.abort();
    dialog.close();
  };
  dialog.addEventListener("cancel", close);
  window.addEventListener("keeper-sign-out", close);
  return function show(card) {
    const turn = ++generation;
    let page = 0,
      choices = [],
      query = "",
      busy = false;
    dialog.innerHTML = `<button type="button" class="close" aria-label="Close printing picker">×</button><h2>Printings of ${esc(card.name)}</h2><p>Choose the set, collector number and language on your physical card. Rules text remains in English.</p><form><label>Printing language<select name="language"><option value="en">English</option><option value="es">Spanish</option><option value="any">All languages</option></select></label><label>Set or collector filters<input name="filters" placeholder="Optional: set:m11 cn:149"></label><button class="primary">Find printings</button></form><p class="printing-status" role="status"></p><div class="printing-results"></div><button type="button" class="secondary printing-more" hidden>More printings</button>`;
    dialog.querySelector(".close").onclick = close;
    async function search(more = false) {
      if (busy) return;
      busy = true;
      const status = dialog.querySelector(".printing-status");
      status.textContent = "Loading exact printings…";
      const controls = [
        ...dialog.querySelectorAll(
          "form button, form input, form select, .printing-more",
        ),
      ];
      controls.forEach((control) => (control.disabled = true));
      if (!more) {
        const form = dialog.querySelector("form"),
          language = form.elements.language.value;
        query = `oracleid:${card.oracle_id} ${language === "any" ? "" : `lang:${language}`} ${form.elements.filters.value.trim()}`;
        page = 0;
        choices = [];
        dialog.querySelector(".printing-results").innerHTML = "";
      }
      controller = new AbortController();
      try {
        const result = await api(
          `/api/search?${new URLSearchParams({ q: query, page: String(page + 1) })}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(25000),
            ]),
          },
        );
        if (turn !== generation || !dialog.open) return;
        choices.push(
          ...result.cards.filter((c) => c.oracle_id === card.oracle_id),
        );
        page++;
        dialog.querySelector(".printing-results").innerHTML = choices
          .map(
            (c, i) =>
              `<button class="printing-choice secondary" type="button" data-choice="${i}">${picture(c)}<span><b>${esc(c.name)}</b><br>${esc(c.set_name)} · ${esc(c.set.toUpperCase())} #${esc(c.collector_number)} · ${esc(c.lang.toUpperCase())}<br>${esc(c.finishes.join(", "))}${c.printed_name ? `<br>${esc(c.printed_name)}` : ""}</span></button>`,
          )
          .join("");
        status.textContent = choices.length
          ? "Select an exact printing to review quantity and finish."
          : "No printings match. Change the language or filters and retry.";
        dialog.querySelector(".printing-more").hidden = !result.hasMore;
        dialog.querySelectorAll("[data-choice]").forEach(
          (button) =>
            (button.onclick = () => {
              const chosen = choices[Number(button.dataset.choice)];
              close();
              onChoose(chosen);
            }),
        );
      } catch (e) {
        if (turn === generation) status.textContent = e.message;
      } finally {
        if (turn === generation) {
          busy = false;
          controls.forEach((control) => (control.disabled = false));
        }
      }
    }
    dialog.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      search();
    };
    dialog.querySelector(".printing-more").onclick = () => search(true);
    dialog.showModal();
    search();
  };
}
