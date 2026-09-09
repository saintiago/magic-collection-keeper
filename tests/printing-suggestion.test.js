import test from "node:test";
import assert from "node:assert/strict";
import { resolveRecognition } from "../public/recognition-candidates.js";
const oracle = "00000000-0000-4000-8000-000000000001";
const cards = ["230s", "230p", "230"].map((number, i) => ({
  id: `00000000-0000-4000-8000-00000000001${i}`,
  oracle_id: oracle,
  name: "Ral, Crackling Wit",
  collector_number: number,
  set: i < 2 ? "pblb" : "blb",
  lang: "en",
  finishes: i < 2 ? ["foil"] : ["nonfoil", "foil"],
}));
test("UC-SCAN-SUGGEST: regular printing beats promo without footer evidence; exact corroboration wins", async () => {
  let lookups = 0;
  const options = {
    attempt: 1,
    request: async (path) => {
      lookups++;
      return { cards: [cards.find((c) => path.includes(c.id))] };
    },
  };
  const data = {
    contractVersion: 1,
    attempt: 1,
    status: "possible",
    candidates: cards,
  };
  const regular = await resolveRecognition(data, options);
  assert.equal(regular.selected.id, cards[2].id);
  assert.equal(regular.finish, "nonfoil");
  assert.equal(regular.suggested, true);
  assert.equal(
    lookups,
    1,
    "Only the suggested canonical printing needs camera-time hydration",
  );
  const exact = await resolveRecognition(
    { ...data, evidence: { exactPrintingId: cards[0].id } },
    options,
  );
  assert.equal(exact.selected.id, cards[0].id);
  assert.equal(exact.finish, "foil");
  const unknown = await resolveRecognition(
    { ...data, status: "unknown" },
    options,
  );
  assert.equal(unknown.selected, null);
  assert.equal(unknown.suggested, false);
});

test("translated title evidence resolves canonical language without adding an English copy", async () => {
  const translated = {
    ...cards[2],
    id: "00000000-0000-4000-8000-000000000019",
    lang: "es",
  };
  const paths = [];
  const result = await resolveRecognition(
    {
      contractVersion: 1,
      attempt: 1,
      status: "possible",
      candidates: cards,
      evidence: { titleLanguage: "es" },
    },
    {
      attempt: 1,
      request: async (path) => {
        paths.push(path);
        return { cards: [translated] };
      },
    },
  );
  assert.equal(result.selected.id, translated.id);
  assert.equal(result.selected.lang, "es");
  assert.equal(paths.length, 1);
  const q = new URL(paths[0], "https://example.test").searchParams.get("q");
  assert.equal(q, `oracleid:${oracle} set:blb cn:230 lang:es`);
});
