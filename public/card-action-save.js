// One account-scoped outstanding intent protects reload after an ambiguous response.
export function createCardActionSave({
  api,
  onOwned,
  onPending,
  onDraft = () => {},
  onSaved = () => {},
  onUsed,
  notify,
  currentView,
}) {
  let key = null,
    pending = null,
    busy = false,
    generation = 0;
  const status = document.createElement("aside");
  status.className = "card-action-status";
  status.hidden = true;
  status.setAttribute("role", "status");
  document.body.append(status);
  function show(text, retry = false) {
    status.replaceChildren();
    status.hidden = false;
    const label = document.createElement("span");
    label.textContent = text;
    status.append(label);
    if (retry) {
      const button = document.createElement("button");
      button.textContent = "Retry card action";
      button.disabled = busy;
      button.onclick = run;
      status.append(button);
    }
    const close = document.createElement("button");
    close.textContent = "×";
    close.setAttribute("aria-label", "Hide action status");
    close.onclick = () => {
      status.hidden = true;
    };
    status.append(close);
  }
  async function run() {
    if (!pending || busy || !key) return;
    const turn = generation,
      intent = pending,
      view = currentView();
    busy = true;
    if (!intent.inline) show("Saving card action…");
    try {
      const result = await api(
        intent.kind === "owned"
          ? "/api/tag-actions"
          : intent.kind === "pending"
            ? "/api/import-draft/tag"
            : "/api/import-draft/stage",
        { method: "POST", body: JSON.stringify(intent.payload) },
      );
      if (turn !== generation) return { cancelled: true };
      sessionStorage.removeItem(key);
      pending = null;
      try {
        if (intent.kind === "owned") onOwned(result);
        else if (result.draft && currentView() === view) {
          onDraft(result);
          if (!intent.inline && intent.kind === "catalog")
            onPending(result.draft.id);
        }
        if (intent.tag) onUsed(intent.tag);
        onSaved(result, intent);
      } catch {
        show(
          "Your card action was saved. Refresh to see the updated collection or pending review.",
        );
        return { result, intent };
      }
      if (!intent.inline)
        show(
          intent.kind === "owned"
            ? "Card tags saved. Owned quantity is unchanged."
            : result.draft
              ? "Pending review saved. Check the printing and use Add to confirm ownership."
              : "This review was already processed. No duplicate copies were added.",
        );
      else status.hidden = true;
      return { result, intent };
    } catch (error) {
      if (
        turn === generation &&
        [400, 403, 404, 409, 422].includes(error.status)
      ) {
        try {
          sessionStorage.removeItem(key);
          pending = null;
          show(
            `${error.message} The action was rejected. Refresh and choose again.`,
          );
        } catch {
          show(
            "The rejected action could not be cleared from this browser. Reload and retry.",
            true,
          );
        }
      } else if (turn === generation)
        show(
          `${error.message} Retry this same action to confirm it safely.`,
          true,
        );
      return {
        error: error.message,
        pending: Boolean(pending),
        cancelled: turn !== generation,
      };
    } finally {
      if (turn === generation) {
        busy = false;
        status.querySelector("button")?.removeAttribute("disabled");
      }
    }
  }
  return {
    start(account) {
      const next = "keeper-card-action-v1:" + account;
      if (key === next) return;
      generation++;
      key = next;
      busy = false;
      pending = null;
      status.hidden = true;
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) {
          pending = JSON.parse(saved);
          if (
            !["owned", "catalog", "pending"].includes(pending?.kind) ||
            !pending.payload
          )
            throw Error("Saved card action is invalid.");
          show(
            "A card action still needs confirmation. Retry before starting another.",
            true,
          );
        }
      } catch (error) {
        key = null;
        show(
          "Saved card actions could not be read. Reload before changing tags.",
        );
      }
    },
    stop() {
      generation++;
      key = null;
      pending = null;
      busy = false;
      status.hidden = true;
      status.replaceChildren();
    },
    async save(intent) {
      if (!key) {
        notify(
          "Your account and retry storage must be ready before changing tags.",
        );
        return {
          error:
            "Your account and retry storage must be ready before changing tags.",
        };
      }
      if (pending) {
        if (
          !busy &&
          intent.inline &&
          pending.inline &&
          sameInlineTarget(intent, pending) &&
          intent.tag === pending.tag
        )
          return run();
        show("Finish the previous card action before starting another.", true);
        return {
          error: "Finish the previous card action before starting another.",
        };
      }
      try {
        sessionStorage.setItem(key, JSON.stringify(intent));
        pending = intent;
      } catch {
        show(
          "This browser could not protect the retry. No request was sent; reload and try again.",
        );
        return {
          error:
            "This browser could not protect the retry. No request was sent.",
        };
      }
      return run();
    },
  };
}

// Loading a committed catalogue review after a lost response changes its local
// descriptor to pending. Its original stage receipt must still be retried.
function sameInlineTarget(next, saved) {
  if (typeof next.itemKey === "string" && next.itemKey === saved.itemKey)
    return true;
  return (
    saved.kind === "catalog" &&
    next.kind === "pending" &&
    saved.payload.id === next.payload.id &&
    saved.payload.rows?.length === 1 &&
    saved.payload.rows[0].id === next.payload.row_id
  );
}
