// Shared accessible tag controls for the 200% preview and click inspector.
export function mountCardTags(root, state) {
  const buttons = new Map();
  const status = document.createElement("p");
  status.className = "card-tags-status";
  status.setAttribute("role", "status");
  const list = document.createElement("div");
  list.className = "card-tag-options";
  const retry = document.createElement("button");
  retry.className = "card-tags-retry";
  retry.textContent = "Retry loading tags";
  retry.onclick = () => state.retry();
  root.replaceChildren(status, list, retry);
  const unsubscribe = state.subscribe(() => {
    const view = state.view;
    root.setAttribute("aria-busy", String(view.loading));
    status.textContent =
      view.loadError ||
      (view.loading
        ? "Loading tags…"
        : view.tags.length
          ? ""
          : "No tags available.");
    status.hidden = !status.textContent;
    status.classList.toggle("visually-hidden", view.loading);
    retry.hidden = !view.loadError;
    for (const [id, choice] of buttons)
      if (!view.tags.some((tag) => tag.id === id)) {
        choice.wrapper.remove();
        buttons.delete(id);
      }
    for (const tag of view.tags) {
      let choice = buttons.get(tag.id);
      if (!choice) {
        const wrapper = document.createElement("span");
        wrapper.className = "card-tag-choice";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "card-tag-toggle";
        button.dataset.inspectorTag = tag.id;
        const label = document.createElement("span");
        const mark = document.createElement("span");
        mark.className = "card-tag-selected";
        mark.textContent = "✓";
        mark.setAttribute("aria-hidden", "true");
        button.append(mark, label);
        const error = document.createElement("span");
        error.className = "card-tag-error";
        error.id = "tag-error-" + crypto.randomUUID();
        error.setAttribute("role", "status");
        button.setAttribute("aria-describedby", error.id);
        button.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          state.select(tag.id);
        };
        wrapper.append(button, error);
        list.append(wrapper);
        choice = { wrapper, button, label, error };
        buttons.set(tag.id, choice);
      }
      const selected = view.desired.has(tag.id)
        ? view.desired.get(tag.id)
        : view.confirmed.has(tag.id);
      choice.label.textContent = tag.label;
      choice.button.title = (selected ? "Remove " : "Add ") + tag.label;
      choice.button.setAttribute("aria-pressed", String(selected));
      choice.button.setAttribute(
        "aria-busy",
        String(view.busy === tag.id || view.desired.has(tag.id)),
      );
      choice.button.disabled = view.loading || Boolean(view.loadError);
      choice.error.textContent = view.errors.get(tag.id) || "";
      choice.error.hidden = !choice.error.textContent;
      choice.wrapper.classList.toggle(
        "has-error",
        Boolean(choice.error.textContent),
      );
    }
  });
  return unsubscribe;
}
