import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectorView } from "../public/artwork-inspector.js";
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
  const details = inspectorView({ kind: "owned", row, card: row.card }, "");
  assert.match(details, /aria-label="Card tags"/);
  assert.match(details, /Artwork unavailable/);
  assert.doesNotMatch(
    details,
    /owned|assigned|Separate source|Hidden printed title|194|<button|<input|<select/,
  );
  assert.equal(JSON.stringify(row), before);
  const escaped = inspectorView(
    { kind: "catalog", card: { name: '<img onerror="bad">' } },
    'https://example.test/a" onerror="bad',
  );
  assert.match(escaped, /alt="&lt;img onerror=&quot;bad&quot;&gt;"/);
  assert.match(
    escaped,
    /src="https:\/\/example.test\/a&quot; onerror=&quot;bad"/,
  );
});
