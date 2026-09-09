import { tagBadges, allocationWarning } from "./tags.js";
import { esc, finishName, conditions, picture, image } from "./view.js";
import { ownedPrintings, ownershipContent } from "./card-ownership-view.js";
const $ = (id) => document.getElementById(id);
export function createCardDetail({
  api,
  onSaved,
  notify,
  onDone,
  onTags,
  onPrinting,
  loadOwned,
}) {
  return function detail(row) {
    const c = row.card;
    const operationId = crypto.randomUUID();
    $("detail-content").innerHTML =
      `<div class="detail-image">${picture(c)}${c.card_faces?.[1]?.image_uris ? '<button class="secondary" id="flip">↻ Flip card</button>' : ""}</div><div class="detail-info"><div class="eyebrow">${row.id ? "IN YOUR COLLECTION" : "REVIEW PRINTING"}</div><p class="type">${esc(c.type_line)}</p><div class="printing">${esc(c.set_name)}<br><b>${esc(c.set.toUpperCase())} · #${esc(c.collector_number)} · ${esc(c.lang.toUpperCase())}</b></div>${!row.id && c.oracle_id ? '<button type="button" class="secondary" id="choose-printing">Change printing or language</button>' : ""}<p class="oracle">${esc(c.oracle_text || c.card_faces?.map((f) => `${f.name}\n${f.oracle_text || ""}`).join("\n\n") || "No rules text.")}</p><form id="inventory-form"><div class="form-row"><label>Quantity<input id="quantity" type="number" min="1" max="100000" step="1" required value="${row.quantity || 1}"></label><label>Finish<select id="finish" ${row.id ? "disabled" : ""}>${c.finishes.map((f) => `<option value="${f}" ${row.finish === f ? "selected" : ""}>${finishName[f] || esc(f)}</option>`).join("")}</select></label></div><div class="form-row"><label>Condition<select id="condition" ${row.id ? "disabled" : ""}>${Object.entries(
        row.condition === "UNK"
          ? { UNK: "Unknown (imported)", ...conditions }
          : conditions,
      )
        .map(
          ([key, val]) =>
            `<option value="${key}" ${row.condition === key ? "selected" : ""}>${val}</option>`,
        )
        .join(
          "",
        )}</select></label><label>Language<input value="${esc(c.lang.toUpperCase())}" disabled></label></div><p class="hint">${row.source_managed && !row.provenance_list?.every((source) => source.provider === "reviewed-capture") ? "Imported condition is unknown. Source printing and finish are retained with their provenance." : row.id ? "To change finish or condition, remove this entry and add it with the correct attributes." : "Check the set, collector number and language against your card. Change printing or language when needed."}</p>${row.id ? `<div class="card-tags">${tagBadges(row)}</div>${allocationWarning(row)}<button type="button" class="secondary full" id="edit-card-tags">Edit locations & tags</button>${(row.provenance_list ?? []).map((p) => `<p class="hint">Source: ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(p.name)}</a>` : esc(p.name)} · ${esc(p.section)}</p>`).join("")}` : ""}<p id="detail-message" role="status"></p><button class="primary full" type="submit">${row.id ? "Save quantity" : "+ Add to collection"}</button>${row.id && (!row.source_managed || row.provenance_list?.every((source) => source.provider === "reviewed-capture")) ? '<button type="button" class="danger full" id="remove">Remove this entry</button>' : ""}</form><a class="scryfall-link" href="${esc(c.scryfall_uri)}" target="_blank" rel="noreferrer">View printing on Scryfall ↗</a></div>`;
    if ($("choose-printing"))
      $("choose-printing").onclick = () => onPrinting(c);
    if ($("edit-card-tags")) $("edit-card-tags").onclick = () => onTags(row);
    if (!row.id) {
      const section = document.createElement("section");
      section.className = "detail-ownership";
      section.setAttribute("aria-label", "Owned printings and tags");
      $("inventory-form").before(section);
      async function refreshOwnership() {
        section.innerHTML =
          '<h3>Your printings & tags</h3><p role="status">Checking your owned printings…</p>';
        const started = performance.now();
        try {
          const matching = ownedPrintings(c, await loadOwned());
          if (!section.isConnected || $("detail").hidden) return;
          window.dispatchEvent(
            new CustomEvent("keeper-card-metric", {
              detail: {
                phase: "ownership-ready",
                ms: performance.now() - started,
              },
            }),
          );
          section.innerHTML = `<h3>Your printings & tags</h3>${ownershipContent(matching)}`;
          section.querySelectorAll("[data-owned-tags]").forEach((button) => {
            button.onclick = () =>
              onTags(matching[Number(button.dataset.ownedTags)]);
          });
        } catch (error) {
          if (!section.isConnected || $("detail").hidden) return;
          window.dispatchEvent(
            new CustomEvent("keeper-card-metric", {
              detail: {
                phase: "ownership-error",
                ms: performance.now() - started,
              },
            }),
          );
          section.innerHTML = `<h3>Your printings & tags</h3><p role="status" class="error">${esc(error.message)}</p><button type="button" class="secondary">Retry owned printings</button>`;
          section.querySelector("button").onclick = refreshOwnership;
        }
      }
      // Open the card immediately; ownership is independently refreshed, never inferred from catalog data.
      queueMicrotask(refreshOwnership);
    }
    let face = 0;
    if ($("flip"))
      $("flip").onclick = () => {
        face = 1 - face;
        $("detail-content").querySelector(".detail-image img").src = image(
          c,
          face,
        );
        $("detail-content").querySelector(".detail-image img").alt =
          c.card_faces[face].name;
      };
    const form = $("inventory-form"),
      detailMessage = $("detail-message");
    const read = (id) => form.querySelector("#" + id);
    $("inventory-form").onsubmit = async (e) => {
      e.preventDefault();
      const submit = e.submitter;
      submit.disabled = true;
      try {
        const quantity = Number(read("quantity").value);
        const updated = await api(
          row.id
            ? `/api/collection/${encodeURIComponent(row.id)}`
            : "/api/collection",
          {
            method: row.id ? "PATCH" : "POST",
            body: JSON.stringify({
              printing_id: c.id,
              quantity,
              finish: read("finish").value,
              condition: read("condition").value,
              operation_id: operationId,
            }),
          },
        );

        onSaved(updated);
        if (form.isConnected) onDone();
        notify(
          row.id
            ? "Quantity saved."
            : `${quantity} × ${c.name} added to your collection.`,
        );
      } catch (e) {
        detailMessage.textContent = e.message;
        submit.disabled = false;
      }
    };
    if ($("remove"))
      $("remove").onclick = async () => {
        if (
          !confirm(
            `Remove all ${row.quantity} copies from this ${finishName[row.finish]} / ${row.condition} entry?`,
          )
        )
          return;
        read("remove").disabled = true;
        try {
          const updated = await api(`/api/collection/${row.id}`, {
            method: "DELETE",
          });

          onSaved(updated);
          if (form.isConnected) onDone();
          notify("Entry removed from your collection.");
        } catch (e) {
          detailMessage.textContent = e.message;
          read("remove").disabled = false;
        }
      };
  };
}
