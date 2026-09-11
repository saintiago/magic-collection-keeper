import { importPageView, draftTagForm } from "./import-page-view.js";
import { esc, picture } from "./view.js";
import { parseList } from "./import.js";
import { listQuery } from "./catalog-query.js";
import { collectionIdentity } from "./auth.js";
import { snapshotKey } from "./collection-cache.js";

export function createImportPage({ root, api, onAdded, back, select }) {
  let data = null,
    busy = false,
    message = "",
    error = false,
    url = "",
    editingRows = null,
    generation = 0,
    visible = false,
    textOpen = false,
    text = "",
    textIntent = null,
    textKey = null,
    textStorageError = "";
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
      textOpen,
      text,
      textFrozen: Boolean(textIntent),
    }));
  const close = () => dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) close();
  });
  window.addEventListener("keeper-sign-out", () => {
    generation++;
    data = null;
    editingRows = null;
    textIntent = null;
    textKey = null;
    text = "";
    textStorageError = "";
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
    const previous = data?.draft?.id;
    const pending = (
      result.pending_drafts ||
      (data?.pending_drafts || []).filter(
        (item) => result.draft || item.id !== previous,
      )
    )
      .filter(
        (item) =>
          item.id !== result.scan_session?.id ||
          result.scan_session.pending_batches > 0,
      )
      .map((item) =>
        item.id === (result.scan_session?.id || result.draft?.id)
          ? {
              ...item,
              copies:
                result.scan_session?.pending_copies ??
                result.summary.reviewed_copies,
            }
          : item,
      );
    if (
      result.draft &&
      !result.scan_session &&
      !pending.some((item) => item.id === result.draft.id)
    )
      pending.push({
        id: result.draft.id,
        name: result.draft.name,
        kind: result.draft.provider === "reviewed-capture" ? "capture" : "url",
        copies: result.summary.reviewed_copies,
        created_at: result.draft.created_at,
      });
    data = { ...result, pending_drafts: pending };
    if (visible)
      history.replaceState(
        history.state,
        "",
        result.draft
          ? "#import=" + result.draft.id
          : result.scan_session
            ? "#import=" + result.scan_session.batch_id
            : "#import",
      );
    editingRows = null;
    message =
      textStorageError ||
      (result.draft
        ? "Saved to your account. Changes are saved as you edit."
        : "No pending import.");
  };
  async function load() {
    const id = location.hash.startsWith("#import=")
      ? location.hash.slice(8)
      : "";
    return run(async () => {
      if (!textKey) {
        const key =
          "keeper-pending-text:" + snapshotKey(await collectionIdentity());
        textKey = key;
        try {
          const saved = JSON.parse(localStorage.getItem(key) || "null");
          if (
            saved &&
            (!saved.intent ||
              !Array.isArray(saved.intent.rows) ||
              saved.intent.rows.length > 50 ||
              typeof saved.text !== "string")
          )
            throw Error("Invalid saved text import");
          if (saved?.intent) {
            textIntent = saved.intent;
            text = saved.text;
            textOpen = true;
          }
        } catch {
          textStorageError =
            "An unfinished text import could not be loaded on this browser. Account-saved imports remain available. Reload before staging another text list.";
        }
      }
      return api(
        "/api/import-draft" + (id ? "?" + new URLSearchParams({ id }) : ""),
      );
    }, accept);
  }
  const identity = () => ({
    id: data.draft.id,
    version: data.draft.version,
    kind: data.draft.provider === "reviewed-capture" ? "capture" : "url",
  });
  async function save(rows) {
    editingRows = rows;
    return run(
      () =>
        api("/api/import-draft", {
          method: "PATCH",
          body: JSON.stringify({
            ...identity(),
            rows: editingRows.map(
              ({
                id,
                quantity,
                printing_id,
                finish,
                in_deck,
                locations,
                tag_ids,
                condition,
              }) => ({
                id,
                quantity,
                printing_id,
                finish,
                in_deck,
                locations,
                tag_ids,
                condition,
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
    dialog.innerHTML = `<button type="button" class="close" data-close aria-label="Close printing choices">×</button><h2>Choose an exact printing</h2><form id="draft-printing-search"><label>Search printings<input name="query" required value="${esc('!"' + (row.card?.name || row.original.name).replaceAll('"', "") + '" lang:' + (row.card?.lang || row.original.language || "en"))}"></label><button class="primary">Find printings</button></form><p id="draft-printing-status" role="status"></p><div id="draft-printing-results"></div><button id="draft-printing-more" class="secondary" hidden>More printings</button>`;
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
    if (event.target.id === "draft-text-form") {
      event.preventDefault();
      text = root.querySelector("#import-text").value;
      const turn = generation + 1;
      return run(
        async () => {
          if (textStorageError) throw Error(textStorageError);
          if (!textIntent) {
            const lines = parseList(text);
            if (
              !lines.length ||
              lines.length > 50 ||
              lines.some((row) => row.error)
            )
              throw Error("Paste 1–50 valid card lines.");
            const rows = [];
            for (const row of lines) {
              const result = await api(
                "/api/search?" + new URLSearchParams({ q: listQuery(row) }),
              );
              if (turn !== generation || !visible)
                throw Error(
                  "Import matching canceled. Your owned cards are unchanged.",
                );
              const card = result.cards.length === 1 ? result.cards[0] : null;
              rows.push({
                id: crypto.randomUUID(),
                name: card?.name || row.name || row.raw,
                printing_id: card?.id || null,
                quantity: row.quantity,
                finish: row.finish,
                condition: "UNK",
              });
            }
            textIntent = { id: crypto.randomUUID(), kind: "text", rows };
          }
          localStorage.setItem(
            textKey,
            JSON.stringify({ intent: textIntent, text }),
          );
          return api("/api/import-draft/stage", {
            method: "POST",
            body: JSON.stringify(textIntent),
          });
        },
        (result) => {
          localStorage.removeItem(textKey);
          textIntent = null;
          text = "";
          textOpen = false;
          accept(result);
          select(result.draft?.id);
        },
      );
    }
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
    if (event.target.dataset.field === "condition")
      changeRow(row.dataset.row, { condition: event.target.value });
    if (event.target.dataset.field === "identity")
      changeRow(row.dataset.row, { printing_id: event.target.value });
  });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || busy) return;
    const id = button.id;
    if (id === "draft-back") return back();
    if (button.dataset.draft) return select(button.dataset.draft);
    if (id === "draft-show-text") {
      textOpen = !textOpen;
      draw();
      return;
    }
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
              ...identity(),
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
              ...identity(),
            }),
          }),
        async (result) => {
          const addedIds = new Set(
            Array.isArray(result.added_printings) ? result.added_printings : [],
          );
          const addedCards = data.draft.rows
            .filter(
              (row) =>
                addedIds.has(row.printing_id) &&
                row.card?.id === row.printing_id,
            )
            .map((row) => row.card);
          data = {
            draft: null,
            ...(result.scan_session
              ? { scan_session: result.scan_session }
              : {}),
            pending_drafts: (data.pending_drafts || [])
              .filter(
                (item) =>
                  item.id !== data.draft.id &&
                  (item.id !== result.scan_session?.id ||
                    result.scan_session.pending_batches > 0),
              )
              .map((item) =>
                item.id === result.scan_session?.id
                  ? { ...item, copies: result.scan_session.pending_copies }
                  : item,
              ),
          };
          history.replaceState(
            history.state,
            "",
            result.scan_session
              ? "#import=" + result.scan_session.batch_id
              : "#import",
          );
          editingRows = null;
          url = "";
          message = `Added ${result.additions} new copies from ${result.reviewed_copies} reviewed copies. This import is saved; retries cannot add duplicates.`;
          try {
            await onAdded(addedCards);
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
    receiveDraft(result) {
      if (
        visible &&
        !busy &&
        !editingRows &&
        result.draft?.id === data?.draft?.id
      ) {
        generation++;
        accept(result);
        draw();
      }
    },
    cardAction(target) {
      if (!visible || busy || editingRows || !target.closest(".draft-artwork"))
        return null;
      const element = target.closest("[data-row]"),
        row = currentRows()?.find((row) => row.id === element?.dataset.row);
      if (!row?.card) return null;
      return {
        element: element.querySelector(".draft-artwork"),
        item: {
          kind: "pending",
          row,
          card: { ...row.card, image_uris: { normal: row.card.image } },
          draftId: data.draft.id,
          draftKind:
            data.draft.provider === "reviewed-capture" ? "capture" : "url",
          sourceId: data.draft.source_id,
          generation,
        },
      };
    },
    async cardActionApply(item, tag) {
      if (
        !visible ||
        busy ||
        generation !== item.generation ||
        data?.draft?.id !== item.draftId
      )
        return;
      const row = currentRows().find((row) => row.id === item.row.id);
      if (!row) return;
      if (tag.action === "details") {
        root
          .querySelector(`[data-row="${row.id}"]`)
          ?.scrollIntoView({ block: "center" });
        return;
      }
      if (tag.action === "edit") return editTags(row);
      if (tag.source?.id === data.draft.source_id)
        return changeRow(row.id, { in_deck: true });
      const locations = row.locations.map((a) => ({ ...a })),
        tag_ids = [...row.tag_ids];
      if (tag.type === "location") {
        const existing = locations.find((a) => a.tag_id === tag.id);
        if (existing) existing.quantity++;
        else locations.push({ tag_id: tag.id, quantity: 1 });
      } else if (!tag_ids.includes(tag.id)) tag_ids.push(tag.id);
      return changeRow(row.id, { locations, tag_ids });
    },
    show() {
      visible = true;
      return load();
    },
    hide() {
      visible = false;
      generation++;
      busy = false;
      close();
    },
  };
}
