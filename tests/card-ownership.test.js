import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownedPrintings,
  ownershipContent,
} from "../public/card-ownership-view.js";

test("UC-27 owned tag targets match Oracle identity across exact printings without inventing ownership", () => {
  const card = { id: "english", oracle_id: "bolt" };
  const spanish = {
    id: "owned-es",
    printing_id: "spanish",
    card: { oracle_id: "bolt" },
  };
  const foil = {
    id: "owned-foil",
    printing_id: "spanish",
    card: { oracle_id: "bolt" },
  };
  const legacy = { id: "legacy", printing_id: "english", card: {} };
  const rows = [
    spanish,
    foil,
    legacy,
    { card },
    { id: "other", printing_id: "other", card: { oracle_id: "other" } },
  ];
  assert.deepEqual(ownedPrintings(card, rows), [spanish, foil, legacy]);
  assert.deepEqual(ownedPrintings({ id: "unknown" }, rows), []);
  assert.match(ownershipContent([]), /before assigning tags/);
});

test("UC-27 printing tag context escapes labels, retains stable IDs and soft shortfalls", () => {
  const html = ownershipContent([
    {
      id: "owned",
      card: { set: "<set>", collector_number: "1", lang: "es" },
      quantity: 2,
      finish: "foil",
      condition: "UNK",
      tags: [{ id: "stable-id", label: "<Burn>", kind: "role" }],
      allocation_shortfall: 1,
      allocated_quantity: 3,
    },
  ]);
  assert.match(html, /&lt;SET&gt;/);
  assert.match(html, /&lt;Burn&gt;/);
  assert.match(html, /data-tag-id="stable-id"/);
  assert.match(html, /3 assigned · 2 owned/);
  assert.match(html, /data-owned-tags="0"/);
});
