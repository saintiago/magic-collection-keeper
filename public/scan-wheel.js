import { esc } from "./view.js";
export function createScanWheel({ viewport, controls, onChange }) {
  let rows = [],
    selected = -1,
    pinned = true,
    settleTimer;
  function layout(end) {
    const oldPad = parseFloat(getComputedStyle(viewport).paddingTop);
    pinned = end;
    const pad = Math.max(0, (viewport.clientHeight - 32) / 2);
    viewport.style.paddingTop = `${end ? pad * 2 : pad}px`;
    viewport.style.paddingBottom = `${end ? 0 : pad}px`;
    viewport.parentElement.dataset.pinned = String(end);
    if (!end) viewport.scrollTop += pad - oldPad;
  }
  function browse() {
    clearTimeout(settleTimer);
    if (pinned && rows.length > 1) layout(false);
  }
  function paint() {
    const options = [...viewport.children];
    options.forEach((option, index) => {
      const distance = Math.min(3, Math.abs(index - selected));
      option.dataset.distance = distance;
      option.setAttribute("aria-selected", String(index === selected));
    });
    const row = rows[selected];
    viewport.setAttribute(
      "aria-activedescendant",
      row ? `scan-row-${row.scanId}` : "",
    );
    controls.hidden = !row;
    if (!row) return;
    controls.setAttribute("aria-label", `Controls for ${row.name}`);
    controls.querySelector("output").textContent = row.quantity;
    controls.querySelector(".scan-minus").disabled = row.quantity <= 1;
    controls.querySelector(".scan-plus").disabled = row.quantity >= 100000;
  }
  function select(index) {
    clearTimeout(settleTimer);
    selected = Math.max(0, Math.min(rows.length - 1, index));
    layout(selected === rows.length - 1);
    paint();
    const target = viewport.children[selected];
    if (target)
      viewport.scrollTo({
        top: pinned
          ? viewport.scrollHeight
          : target.offsetTop -
            viewport.clientHeight / 2 +
            target.offsetHeight / 2,
        behavior: "instant",
      });
  }
  function nearest() {
    if (pinned) {
      selected = rows.length - 1;
      paint();
      return;
    }
    const center = viewport.scrollTop + viewport.clientHeight / 2;
    let best = 0,
      distance = Infinity;
    [...viewport.children].forEach((option, index) => {
      const delta = Math.abs(
        option.offsetTop + option.offsetHeight / 2 - center,
      );
      if (delta < distance) {
        distance = delta;
        best = index;
      }
    });
    selected = rows.length ? best : -1;
    paint();
  }
  viewport.addEventListener(
    "scroll",
    () => {
      nearest();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => select(selected, false), 240);
    },
    { passive: true },
  );
  viewport.addEventListener("scrollend", () => {
    clearTimeout(settleTimer);
    nearest();
    select(selected, false);
  });
  for (const event of ["pointerdown", "wheel", "touchstart"])
    viewport.addEventListener(event, browse, {
      passive: true,
    });
  viewport.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (option) select(Number(option.dataset.index));
  });
  viewport.addEventListener("keydown", (event) => {
    const next = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: rows.length - 1,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      select(next);
    }
  });
  function change(delta) {
    const row = rows[selected];
    if (!row) return;
    row.quantity = Math.max(1, Math.min(100000, row.quantity + delta));
    paint();
    onChange();
  }
  controls.querySelector(".scan-minus").onclick = () => change(-1);
  controls.querySelector(".scan-plus").onclick = () => change(1);
  controls.querySelector(".scan-remove").onclick = () => {
    if (selected < 0) return;
    rows.splice(selected, 1);
    update(rows, false);
    onChange();
  };
  function update(next, newest = false) {
    rows = next;
    viewport.innerHTML = rows
      .map(
        (row, index) =>
          `<div class="scan-option" role="option" id="scan-row-${row.scanId}" data-index="${index}"><span>${esc(row.name)}</span><small>${row.processing ? "Reading…" : row.selected ? "✓ Matched" : "! Review"}</small></div>`,
      )
      .join("");
    select(newest ? rows.length - 1 : selected, false);
  }
  const resize = new ResizeObserver(() => {
    select(selected, false);
  });
  resize.observe(viewport);
  return {
    update,
    destroy() {
      resize.disconnect();
      clearTimeout(settleTimer);
    },
  };
}
