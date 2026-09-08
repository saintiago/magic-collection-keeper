import { importPageView, draftTagForm } from "./import-page-view.js";
import { esc, picture } from "./view.js";

export function createImportPage({ root, api, onAdded }) {
  let data = null,
    busy = false,
    message = "",
    error = false,
    url = "",
    editingRows = null,
    generation = 0,
    visible = false;
  const dialog = document.createElement("dialog");
  dialog.className = "draft-dialog";
  document.body.append(dialog);
  const draw = () =>
    (root.innerHTML = importPageView({
      data,
      busy,
      message,
      error,
      url,
      rows: editingRows,
      dirty: Boolean(editingRows),
    }));
  const close = () => dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) close();
  });
  window.addEventListener("keeper-sign-out", () => {
    generation++;
    data = null;
    editingRows = null;
    close();
    draw();
  });
  async function run(action, success) {
    if (busy) return false;
    const turn = ++generation;
    busy = true;
    error = false;
    message = "Saving…";
    draw();
    try {
      const result = await action();
      if (turn !== generation) return false;
      await success(result);
      return true;
    } catch (e) {
      if (turn === generation) {
        message = e.message;
        error = true;
      }
      return false;
    } finally {
      if (turn === generation) {
        busy = false;
        draw();
      }
    }
  }
  const accept = (result) => {
    data = result;
    editingRows = null;
    message = result.draft
      ? "Saved to your account. Changes are saved as you edit."
      : "No pending import.";
  };
  async function load() {
    return run(() => api("/api/import-draft"), accept);
  }
  async function save(rows) {
    editingRows = rows;
    return run(
      () =>
        api("/api/import-draft", {
          method: "PATCH",
          body: JSON.stringify({
            id: data.draft.id,
            version: data.draft.version,
            rows: editingRows.map(
              ({
                id,
                quantity,
                printing_id,
                finish,
                in_deck,
                locations,
                tag_ids,
              }) => ({
                id,
                quantity,
                printing_id,
                finish,
                in_deck,
                locations,
                tag_ids,
              }),
            ),
          }),
        }),
      accept,
    );
  }
  const currentRows = () => editingRows || data.draft.rows;
  const changeRow = (id, patch) =>
    save(
      currentRows().map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  async function editTags(row) {
    const turn = generation;
    try {
      const tags = await api("/api/tags");
      if (!visible || turn !== generation) return;
      dialog.innerHTML = draftTagForm(row, data.draft, tags);
      dialog.showModal();
      dialog.querySelector("form").onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          button = form.querySelector("button");
        button.disabled = true;
        const locations = [
          ...form.querySelectorAll("[data-location]:checked"),
        ].map((input) => ({
          tag_id: input.dataset.location,
          quantity: Number(
            form.querySelector(
              `[data-location-quantity="${input.dataset.location}"]`,
            ).value,
          ),
        }));
        const tag_ids = [
          ...form.querySelectorAll("[data-classification]:checked"),
        ].map((input) => input.dataset.classification);
        const saved = await changeRow(row.id, {
          locations,
          tag_ids,
          in_deck: form.elements.in_deck.checked,
        });
        if (saved) close();
        else {
          button.disabled = false;
          form.querySelector("#draft-tag-error").textContent = message;
        }
      };
    } catch (e) {
      message = e.message;
      error = true;
      draw();
    }
  }
  function editPrinting(row) {
    const turn = generation;
    dialog.innerHTML = `<button type="button" class="close" data-close aria-label="Close printing choices">×</button><h2>Choose an exact printing</h2><form id="draft-printing-search"><label>Search printings<input name="query" required value="${esc('!"' + row.original.name.replaceAll('"', "") + '" lang:' + (row.card?.lang || row.original.language || "en"))}"></label><button class="primary">Find printings</button></form><p id="draft-printing-status" role="status"></p><div id="draft-printing-results"></div><button id="draft-printing-more" class="secondary" hidden>More printings</button>`;
    dialog.showModal();
    let page = 0,
      query = "",
      choices = [],
      searching = false,
      searchId = 0;
    async function search(more = false) {
      if (searching) return;
      searching = true;
      const token = ++searchId;
      if (!more) {
        query = dialog.querySelector("input[name=query]").value.trim();
        page = 0;
        choices = [];
      }
      const status = dialog.querySelector("#draft-printing-status");
      status.textContent = "Finding printings…";
      try {
        const result = await api(
          `/api/search?${new URLSearchParams({ q: query, page: String(page + 1) })}`,
        );
        if (!dialog.open || turn !== generation || token !== searchId) return;
        page++;
        choices.push(...result.cards);
        status.textContent = choices.length
          ? `${result.total} matching printings. Choose one; its finish is reviewed separately.`
          : "No printings found. Try a different query.";
        dialog.querySelector("#draft-printing-results").innerHTML = choices
          .map(
            (card, index) =>
              `<button type="button" class="draft-printing-choice" data-printing="${index}">${picture(card)}<span>${esc(card.name)}<br>${esc(card.set.toUpperCase())} #${esc(card.collector_number)} · ${esc(card.lang.toUpperCase())}<br>${esc(card.finishes.join(", "))}</span></button>`,
          )
          .join("");
        dialog.querySelector("#draft-printing-more").hidden = !result.hasMore;
        dialog.querySelectorAll("[data-printing]").forEach(
          (button) =>
            (button.onclick = async () => {
              if (busy) return;
              const controls = [...dialog.querySelectorAll("button, input")];
              controls.forEach((control) => (control.disabled = true));
              const card = choices[Number(button.dataset.printing)];
              const saved = await changeRow(row.id, { printing_id: card.id });
              if (saved) close();
              else {
                controls.forEach((control) => (control.disabled = false));
                status.textContent = message;
              }
            }),
        );
      } catch (e) {
        if (dialog.open) status.textContent = e.message;
      } finally {
        searching = false;
      }
    }
    dialog.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      search();
    };
    dialog.querySelector("#draft-printing-more").onclick = () => search(true);
    search();
  }
  root.addEventListener("submit", (event) => {
    if (event.target.id !== "draft-fetch-form") return;
    event.preventDefault();
    url = root.querySelector("#moxfield-url").value;
    run(
      () =>
        api("/api/import-draft/fetch", {
          method: "POST",
          body: JSON.stringify({ url }),
        }),
      accept,
    );
  });
  root.addEventListener("change", (event) => {
    const row = event.target.closest("[data-row]");
    if (!row || busy) return;
    if (event.target.dataset.field === "quantity")
      changeRow(row.dataset.row, { quantity: Number(event.target.value) });
    if (event.target.dataset.field === "finish")
      changeRow(row.dataset.row, { finish: event.target.value });
  });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    const id = button.id;
    if (id === "draft-reload") {
      editingRows = null;
      return load();
    }
    if (id === "draft-retry-save") return save(editingRows);
    if (id === "draft-clear")
      return run(
        () =>
          api("/api/import-draft/clear", {
            method: "POST",
            body: JSON.stringify({
              id: data.draft.id,
              version: data.draft.version,
            }),
          }),
        (result) => {
          url = "";
          accept(result);
          message = "Pending import cleared. Owned cards are unchanged.";
        },
      );
    if (id === "draft-add")
      return run(
        () =>
          api("/api/import-draft/add", {
            method: "POST",
            body: JSON.stringify({
              id: data.draft.id,
              version: data.draft.version,
            }),
          }),
        async (result) => {
          data = { draft: null };
          editingRows = null;
          url = "";
          message = `Added ${result.additions} new copies from ${result.reviewed_copies} reviewed copies. This import is saved; retries cannot add duplicates.`;
          try {
            await onAdded();
          } catch {
            message += " Refresh the collection to see its latest totals.";
          }
        },
      );
    const rowId = button.closest("[data-row]")?.dataset.row;
    if (!rowId) return;
    const row = currentRows()?.find((row) => row.id === rowId);
    if (!row) return;
    if (button.dataset.action === "remove")
      return save(currentRows().filter((row) => row.id !== rowId));
    if (button.dataset.action === "tags") return editTags(row);
    if (button.dataset.action === "printing") return editPrinting(row);
  });
  draw();
  return {
    show() {
      visible = true;
      load();
    },
    hide() {
      visible = false;
      close();
    },
  };
}
