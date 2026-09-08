import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectionCountText,
  displayedQuantity,
  sourceCounts,
} from "../public/collection-counts.js";
import { planDeck } from "../domain/deck-import.js";
test("UC-18 location copies sum repeated printing/finish rows without using pooled ownership", () => {
  const tag = { id: "deck", type: "location" };
  const rows = [
    {
      printing_id: "land",
      finish: "nonfoil",
      quantity: 20,
      locations: [
        { tag_id: "deck", quantity: 6 },
        { tag_id: "other", quantity: 14 },
      ],
    },
    {
      printing_id: "land",
      finish: "foil",
      quantity: 2,
      locations: [
        { tag_id: "deck", quantity: 1 },
        { tag_id: "other", quantity: 1 },
      ],
    },
  ];
  assert.equal(
    collectionCountText(rows, rows, tag),
    "7 assigned copies · 2 distinct entries",
  );
  assert.equal(
    collectionCountText(rows, rows.slice(0, 1), tag),
    "6 assigned copies of 7 · 1 distinct entry",
  );
  assert.equal(displayedQuantity(rows[0], tag), 6);
  assert.equal(
    collectionCountText(rows, rows),
    "22 owned copies · 2 distinct entries",
  );
  assert.equal(
    collectionCountText(rows, [], tag),
    "0 assigned copies of 7 · 0 distinct entries",
  );
});
test("UC-18 source count includes commanders, multi-copy main entries and pending, excludes loose high-water copies", () => {
  const input = {
    entries: [
      {
        printing_id: "commander",
        finish: "nonfoil",
        section: "commanders",
        quantity: 1,
      },
      {
        printing_id: "land",
        finish: "nonfoil",
        section: "mainboard",
        quantity: 6,
      },
      {
        printing_id: "land",
        finish: "foil",
        section: "mainboard",
        quantity: 2,
      },
    ],
    pending: [{ quantity: 1 }],
  };
  const previous = {
    lots: [
      {
        line_id: "land|nonfoil",
        owned_quantity: 9,
        allocated_quantity: 9,
        printing_id: "land",
        finish: "nonfoil",
      },
    ],
  };
  const plan = planDeck(previous, input, (value) => value);
  assert.equal(plan.owned, 12);
  assert.deepEqual(sourceCounts({ ...input, lots: plan.lots }), {
    total: 10,
    imported: 9,
    pending: 1,
  });
});
