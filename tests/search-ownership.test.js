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
  assert.deepEqual(
    suggestionOwnership(item, searchOwnership({ rows, status: "ready" })),
    { text: "5 owned", owned: true },
  );
  assert.deepEqual(
    suggestionOwnership(
      { oracle_id: "unowned" },
      searchOwnership({ rows, status: "ready" }),
    ),
    { text: "Not owned", owned: false },
  );
  assert.match(
    suggestionOwnership(item, searchOwnership({ rows, status: "updating" }))
      .text,
    /Saved: 5 owned · updating/,
  );
  assert.match(
    suggestionOwnership(item, searchOwnership({ rows, status: "error" })).text,
    /update failed/,
  );
  assert.equal(
    suggestionOwnership(item, searchOwnership({ rows: null, status: "error" }))
      .text,
    "Ownership unavailable",
  );
  assert.equal(
    suggestionOwnership(
      item,
      searchOwnership({ rows: null, status: "loading" }),
    ).text,
    "Checking ownership…",
  );
  assert.equal(
    suggestionOwnership(item, searchOwnership({ rows: [], status: "ready" }))
      .text,
    "Not owned",
  );
  assert.equal(
    suggestionOwnership(
      { printing_id: "en" },
      searchOwnership({
        rows: [{ printing_id: "en", card: {}, quantity: 2 }],
        status: "ready",
      }),
    ).text,
    "2 owned",
  );
});
