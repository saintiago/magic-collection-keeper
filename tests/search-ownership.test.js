import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchOwnership,
  suggestionOwnership,
} from "../public/search-ownership.js";
test("UC-29 ownership indicators aggregate exact printings by identity and retain honest snapshot status", () => {
  const rows = [
    { printing_id: "en", card: { oracle_id: "bolt" }, quantity: 2 },
    { printing_id: "es", card: { oracle_id: "bolt" }, quantity: 3 },
  ];
  const item = { oracle_id: "bolt", printing_id: "en" };
  assert.equal(
    searchOwnership({ rows, status: "ready" }).identities.get("bolt"),
    5,
  );
  for (const status of ["updating", "error"]) {
    const badge = suggestionOwnership(item, searchOwnership({ rows, status }));
    assert.equal(badge.icon, "◷");
    assert.equal(badge.owned, false);
    assert.doesNotMatch(badge.label, /\d/);
  }
  assert.deepEqual(
    suggestionOwnership(item, searchOwnership({ rows, status: "ready" })),
    { label: "Owned", icon: "✓", owned: true },
  );
  assert.deepEqual(
    suggestionOwnership(
      { oracle_id: "unowned" },
      searchOwnership({ rows, status: "ready" }),
    ),
    { label: "Not owned", icon: "○", owned: false },
  );
  assert.match(
    suggestionOwnership(item, searchOwnership({ rows, status: "updating" }))
      .label,
    /Saved: owned · updating/,
  );
  assert.match(
    suggestionOwnership(item, searchOwnership({ rows, status: "error" })).label,
    /update failed/,
  );
  assert.equal(
    suggestionOwnership(item, searchOwnership({ rows: null, status: "error" }))
      .label,
    "Ownership unavailable",
  );
  assert.equal(
    suggestionOwnership(
      item,
      searchOwnership({ rows: null, status: "loading" }),
    ).label,
    "Checking ownership…",
  );
  assert.equal(
    suggestionOwnership(item, searchOwnership({ rows: [], status: "ready" }))
      .label,
    "Not owned",
  );
  assert.equal(
    suggestionOwnership(
      { printing_id: "en" },
      searchOwnership({
        rows: [{ printing_id: "en", card: {}, quantity: 2 }],
        status: "ready",
      }),
    ).label,
    "Owned",
  );
});
