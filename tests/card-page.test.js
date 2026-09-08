import { test } from "node:test";
import assert from "node:assert/strict";
import { cardHref, cardFromHash } from "../public/card-route.js";
import { createDiscoveryService } from "../application/discovery.js";
import { routeCollection } from "../application/routes.js";
const printing = "11111111-1111-4111-8111-111111111111",
  oracle = "22222222-2222-4222-8222-222222222222";
test("UC-35 card routes round-trip exact identity and opaque entry; malformed links never become a search", () => {
  const ref = {
    printing_id: printing,
    oracle_id: oracle,
    entry: "owner-row / & #",
    lang: "es",
  };
  assert.deepEqual(cardFromHash(cardHref(ref)), ref);
  for (const hash of [
    "#card=bad&oracle=" + oracle,
    "#card=" + printing + "&oracle=bad",
    "#card=" + printing + "&oracle=" + oracle + "&lang=<script>",
  ])
    assert.deepEqual(cardFromHash(hash), { invalid: true });
  assert.equal(cardFromHash("#catalog"), null);
  assert.equal(
    cardHref({ ...ref, name: "private", quantity: 99 }).includes("private"),
    false,
  );
});
test("UC-35 exact foreign printing read validates IDs and paper identity without names or ownership; English discovery remains strict", async () => {
  let names = 0,
    reads = 0;
  const card = {
    id: printing,
    oracle_id: oracle,
    lang: "es",
    games: ["paper"],
    oracle_text: "English rules",
  };
  const service = createDiscoveryService({
    names: {
      get() {
        names++;
        throw Error("Unneeded index");
      },
    },
    catalog: {
      resolve: async () => {
        reads++;
        return [card];
      },
    },
  });
  const result = await routeCollection(
    service,
    "verified-owner",
    "GET",
    "/api/card",
    null,
    { printing, oracle },
  );
  assert.equal(result.cards[0], card);
  assert.equal(names, 0);
  await service.card(oracle, printing);
  assert.equal(reads, 1);
  await assert.rejects(() => service.card(oracle, "bad"), /Invalid/);
  await assert.rejects(() => service.card(printing, printing), /verified/);
  await assert.rejects(
    () => service.discover("Card", 1, oracle, printing),
    /English/,
  );
  assert.equal(names, 0);
});
