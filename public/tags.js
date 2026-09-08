import { deckSourceCard } from "./deck-source-view.js";
import { esc } from "./view.js";
export const TAG_STYLE = {
  deck: { icon: "▣", label: "Deck" },
  binder: { icon: "▤", label: "Binder" },
  box: { icon: "▧", label: "Box" },
  other: { icon: "⌖", label: "Other location" },
  role: { icon: "✧", label: "Role" },
  category: { icon: "◇", label: "Category" },
};
export function tagBadges(row) {
  const locations = (row.locations ?? []).map(
    (a) =>
      `<span class="tag-badge tag-${esc(a.tag?.kind || "other")}">${TAG_STYLE[a.tag?.kind]?.icon || "⌖"} ${esc(a.tag?.label || "Unknown location")} <b>×${a.quantity}</b></span>`,
  );
  const classifications = (row.tags ?? []).map(
    (t) =>
      `<span class="tag-badge tag-${esc(t.kind)}">${TAG_STYLE[t.kind]?.icon || "◇"} ${esc(t.label)}</span>`,
  );
  return [...locations, ...classifications].join("");
}
export function allocationWarning(row) {
  return row.allocation_shortfall
    ? `<span class="allocation-warning" role="note" title="Location assignments exceed the owned total by ${row.allocation_shortfall}. Edit tags or the owned total to resolve this; no allocations were removed.">${row.allocated_quantity} assigned · ${row.quantity} owned</span>`
    : "";
}

export function createTagController({ api, onChanged }) {
  let tags = [];
  const dialog = document.createElement("dialog");
  dialog.className = "tag-dialog";
  document.body.append(dialog);
  const find = (id) => dialog.querySelector(`#${id}`);
  async function refresh() {
    tags = await api("/api/tags");
    return tags;
  }
  function shell(title, content) {
    dialog.innerHTML = `<button class="close" id="tags-close" aria-label="Close tags">×</button><div class="eyebrow">YOUR ORGANIZATION</div><h2>${esc(title)}</h2>${content}<p id="tag-message" role="status" aria-live="polite"></p>`;
    find("tags-close").onclick = () => dialog.close();
    if (!dialog.open) dialog.showModal();
  }
  function say(error) {
    find("tag-message").textContent = error.message || error;
  }
  async function manager() {
    shell("Tags & locations", '<p class="hint">Loading your tags…</p>');
    try {
      await refresh();
      renderManager();
    } catch (error) {
      say(error);
    }
  }
  function tagForm() {
    return `<form id="create-tag"><div class="form-row"><label>Tag name<input id="tag-label" required maxlength="100" placeholder="e.g. Card Draw"></label><label>Type<select id="tag-type"><option value="location">Location</option><option value="role">Role</option><option value="category">Category</option></select></label><label>Kind<select id="tag-kind"><option value="deck">Deck</option><option value="binder">Binder</option><option value="box">Box</option><option value="other">Other location</option></select></label></div><button class="primary">Create tag</button></form>`;
  }
  function bindCreate(after) {
    find("tag-type").onchange = () => {
      const type = find("tag-type").value;
      find("tag-kind").innerHTML = (
        type === "location" ? ["deck", "binder", "box", "other"] : [type]
      )
        .map((k) => `<option value="${k}">${TAG_STYLE[k].label}</option>`)
        .join("");
    };
    find("create-tag").onsubmit = async (e) => {
      e.preventDefault();
      e.submitter.disabled = true;
      try {
        tags = await api("/api/tags", {
          method: "POST",
          body: JSON.stringify({
            label: find("tag-label").value,
            type: find("tag-type").value,
            kind: find("tag-kind").value,
          }),
        });
        await after();
      } catch (error) {
        say(error);
        e.submitter.disabled = false;
      }
    };
  }
  function renderManager() {
    shell(
      "Tags & locations",
      `<p class="hint">Names can change; tag identities stay stable. Locations carry copy quantities. Roles and categories do not consume copies.</p>${tagForm()}<div class="tag-registry">${tags.map((t) => `<form class="tag-record" data-id="${t.id}"><span class="tag-badge tag-${t.kind}">${TAG_STYLE[t.kind].icon} ${TAG_STYLE[t.kind].label}</span><input aria-label="Rename ${esc(t.label)}" value="${esc(t.label)}" maxlength="100" required><button class="secondary">Rename</button><button type="button" class="danger delete-tag">Delete</button><small>${t.references} references${t.source ? " · imported source" : ""}</small></form>`).join("") || '<p class="hint">No tags yet. Create a location or classification above.</p>'}</div><button class="secondary" id="deck-sources">View deck sources</button>`,
    );
    bindCreate(async () => {
      renderManager();
      await onChanged();
      say("Tag created.");
    });
    dialog.querySelectorAll(".tag-record").forEach((form) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        try {
          tags = await api(`/api/tags/${form.dataset.id}`, {
            method: "PATCH",
            body: JSON.stringify({ label: form.querySelector("input").value }),
          });
          renderManager();
          await onChanged();
          say("Tag renamed. Existing assignments use the new name.");
        } catch (error) {
          say(error);
        }
      };
      form.querySelector(".delete-tag").onclick = async () => {
        try {
          tags = await api(`/api/tags/${form.dataset.id}`, {
            method: "DELETE",
          });
          renderManager();
          await onChanged();
          say("Unused tag deleted.");
        } catch (error) {
          say(error);
        }
      };
    });
    find("deck-sources").onclick = sources;
  }
  async function sources() {
    shell("Deck sources", '<p class="hint">Loading imported decks…</p>');
    try {
      const decks = await api("/api/deck-imports");
      shell(
        "Deck sources",
        `<p class="hint">Each source contributes its own copies. Existing loose inventory is preserved. Removed source cards remain owned as loose copies. Manual total and tag edits are retained.</p>${decks.map(deckSourceCard).join("") || '<p class="hint">No deck sources imported yet.</p>'}<button class="secondary" id="back-tags">Back to tags</button>`,
      );
      find("back-tags").onclick = renderManager;
    } catch (error) {
      say(error);
    }
  }
  async function edit(row) {
    shell("Card tags", '<p class="hint">Loading tags…</p>');
    try {
      await refresh();
      renderAssignments(row);
    } catch (error) {
      say(error);
    }
  }
  function renderAssignments(row) {
    let locations = (row.locations ?? []).map((a) => ({
        tag_id: a.tag_id,
        quantity: a.quantity,
      })),
      selected = new Set(row.tag_ids ?? []);
    const render = () => {
      shell(
        `Tags · ${row.card.name}`,
        `<p>${row.quantity} owned · <span id="assigned-count"></span></p><p class="hint">Assign quantities to distinct locations. A shortfall is a reminder only; your owned total and other assignments are preserved.</p><div id="location-rows">${locations
          .map(
            (a, i) =>
              `<div class="location-row" data-index="${i}"><select aria-label="Location ${i + 1}">${tags
                .filter((t) => t.type === "location")
                .map(
                  (t) =>
                    `<option value="${t.id}" ${t.id === a.tag_id ? "selected" : ""}>${esc(t.label)} (${TAG_STYLE[t.kind].label})</option>`,
                )
                .join(
                  "",
                )}</select><input aria-label="Copies at location ${i + 1}" type="number" min="1" max="100000" value="${a.quantity}"><button class="danger remove-location" type="button" aria-label="Remove location ${i + 1}">Remove</button></div>`,
          )
          .join(
            "",
          )}</div><button class="secondary" id="add-location" ${tags.some((t) => t.type === "location" && !locations.some((a) => a.tag_id === t.id)) ? "" : "disabled"}>Add location</button><h3>Roles & categories</h3><div class="classification-choices">${
          tags
            .filter((t) => t.type !== "location")
            .map(
              (t) =>
                `<label><input type="checkbox" value="${t.id}" ${selected.has(t.id) ? "checked" : ""}> ${esc(t.label)} <small>(${TAG_STYLE[t.kind].label})</small></label>`,
            )
            .join("") || '<p class="hint">Create a role or category below.</p>'
        }</div><button class="primary full" id="save-tags">Save card tags</button><details><summary>Create a tag here</summary>${tagForm()}</details>`,
      );
      const updateCount = () => {
        const assigned = locations.reduce((n, a) => n + Number(a.quantity), 0);
        find("assigned-count").textContent =
          `${assigned} assigned · ${Math.max(0, row.quantity - assigned)} unassigned${assigned > row.quantity ? ` · ${assigned - row.quantity} short` : ""}`;
      };
      updateCount();
      dialog.querySelectorAll(".location-row").forEach((element) => {
        const index = Number(element.dataset.index);
        element.querySelector("select").onchange = (e) => {
          locations[index].tag_id = e.target.value;
        };
        element.querySelector("input").oninput = (e) => {
          locations[index].quantity = Number(e.target.value);
          updateCount();
        };
        element.querySelector("button").onclick = () => {
          locations.splice(index, 1);
          render();
        };
      });
      find("add-location").onclick = () => {
        const tag = tags.find(
          (t) =>
            t.type === "location" && !locations.some((a) => a.tag_id === t.id),
        );
        if (tag) {
          locations.push({ tag_id: tag.id, quantity: 1 });
          render();
        }
      };
      dialog
        .querySelectorAll(".classification-choices input")
        .forEach(
          (box) =>
            (box.onchange = () =>
              box.checked
                ? selected.add(box.value)
                : selected.delete(box.value)),
        );
      find("save-tags").onclick = async () => {
        find("save-tags").disabled = true;
        try {
          await api("/api/tag-assignments", {
            method: "PUT",
            body: JSON.stringify({
              inventory_id: row.id,
              locations,
              tag_ids: [...selected],
            }),
          });
          dialog.close();
          await onChanged();
        } catch (error) {
          say(error);
          find("save-tags").disabled = false;
        }
      };
      bindCreate(async () => {
        render();
        say("Tag created. Choose it above and save the card tags.");
      });
    };
    render();
  }
  return { manager, edit, refresh };
}
