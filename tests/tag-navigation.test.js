import { test } from "node:test";
import assert from "node:assert/strict";
import { tagHref, tagFromHash } from "../public/tag-navigation.js";
import { tagLink } from "../public/tag-view.js";
import { collectionCard } from "../public/collection-view.js";
test("UC-19 navigation encodes stable IDs and escapes editable labels", () => {
  const first = {
    id: "first &/?",
    label: 'Same <label> "',
    kind: "role",
    type: "role",
  };
  const second = { ...first, id: "second" };
  assert.equal(tagFromHash(tagHref(first.id)), first.id);
  assert.equal(tagFromHash("#"), "");
  assert.notEqual(tagHref(first.id), tagHref(second.id));
  assert.match(tagLink(first), /Same &lt;label&gt; &quot;/);
  assert.ok(!tagLink(first).includes('href="#tag=Same'));
});
test("UC-19 card tags are siblings of the card-opening button", () => {
  const tag = { id: "deck", label: "Deck", kind: "deck", type: "location" };
  const html = collectionCard(
    {
      id: "row",
      printing_id: "p",
      quantity: 3,
      finish: "nonfoil",
      condition: "NM",
      locations: [{ tag_id: tag.id, tag, quantity: 2 }],
      card: { name: "Card", set: "tst", lang: "en" },
    },
    0,
    tag,
  );
  assert.ok(html.indexOf("</button>") < html.indexOf('data-tag-id="deck"'));
  assert.match(html, /2 assigned here/);
});
