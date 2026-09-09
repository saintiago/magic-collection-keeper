import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectorDetails } from "../public/artwork-inspector.js";
import { tagBadges } from "../public/tag-view.js";

test("UC-CARD-ART plain tags preserve identities and quantities while printed metadata stays off overlays", () => {
  const row = {
    quantity: 1,
    finish: "nonfoil",
    condition: "NM",
    card: { name: "Hidden printed title", set: "tst", collector_number: "194" },
    locations: [
      {
        tag_id: "stable-1",
        quantity: 2,
        tag: { id: "stable-1", label: "Deck <A>", kind: "deck" },
      },
    ],
    tags: [],
    allocated_quantity: 2,
    allocation_shortfall: 1,
    provenance_list: [
      { name: "Deck <A>", section: "mainboard" },
      { name: "Separate source", section: "sideboard" },
    ],
  };
  const before = JSON.stringify(row);
  const tags = tagBadges(row);
  assert.match(tags, /data-tag-id="stable-1"/);
  assert.match(tags, />Deck &lt;A&gt;<\/a>/);
  assert.doesNotMatch(tags, /[×▣]/);
  const details = inspectorDetails({ kind: "owned", row, card: row.card });
  assert.match(details, /1 owned/);
  assert.match(details, /2 assigned · 1 owned/);
  assert.match(details, /Separate source/);
  assert.doesNotMatch(details, /Hidden printed title|194|Source: Deck/);
  assert.equal(JSON.stringify(row), before);
  assert.equal(inspectorDetails({ kind: "catalog", card: row.card }), "");
});
