import {
  readFileSync,
  createReadStream,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import {
  parseMoxfieldExport,
  normalizeCardName,
} from "../domain/moxfield-export.js";
const directory = "data/imports";
const overrides = existsSync(`${directory}/printing-overrides.json`)
  ? JSON.parse(readFileSync(`${directory}/printing-overrides.json`))
  : [];
const decks = JSON.parse(readFileSync(`${directory}/commander-decks.json`)).map(
  (d) =>
    parseMoxfieldExport(
      JSON.parse(readFileSync(`${directory}/${d.source_id}.json`)),
    ),
);
const wanted = new Set(
  decks.flatMap((d) => d.entries.map((e) => `${e.set}|${e.collector_number}`)),
);
const matches = new Map();
const stream = createInterface({
  input: createReadStream(`${directory}/scryfall-all.jsonl.gz`).pipe(
    createGunzip(),
  ),
  crlfDelay: Infinity,
});
for await (const line of stream) {
  if (!line.trim()) continue;
  const card = JSON.parse(line),
    key = `${card.set}|${card.collector_number}`;
  if (wanted.has(key)) {
    if (!matches.has(key)) matches.set(key, []);
    matches.get(key).push(card);
  }
}
const problems = [],
  digital = [],
  used = new Map();
const manifests = decks.map((d) => ({
  provider: "moxfield",
  source_id: d.source_id,
  name: d.name,
  folder: d.folder,
  url: d.url,
  retrieved_at: d.retrieved_at,
  excluded: d.excluded,
  entries: d.entries
    .map((e) => {
      const candidates = matches.get(`${e.set}|${e.collector_number}`) ?? [];
      const english = candidates.filter((c) => c.lang === "en");
      const override = overrides.find(
        (o) =>
          o.source_id === d.source_id &&
          o.set === e.set &&
          o.collector_number === e.collector_number,
      );
      const choices = override
        ? candidates.filter((c) => c.id === override.printing_id)
        : english.length
          ? english
          : candidates;
      if (choices.length !== 1) {
        problems.push({
          deck: d.name,
          line: e,
          reason: `${choices.length} printing matches`,
        });
        return null;
      }
      const c = choices[0];
      const names = [
        c.name,
        c.flavor_name,
        c.printed_name,
        ...(c.card_faces ?? []).flatMap((f) => [
          f.name,
          f.flavor_name,
          f.printed_name,
        ]),
      ]
        .filter(Boolean)
        .map(normalizeCardName);
      if (
        !names.includes(normalizeCardName(e.name)) &&
        !names.includes(normalizeCardName(e.name.split(" / ")[0]))
      )
        problems.push({
          deck: d.name,
          line: e,
          reason: `Canonical name differs: ${c.name}`,
        });
      if (!c.finishes.includes(e.finish))
        problems.push({
          deck: d.name,
          line: e,
          reason: `Unsupported finish (${c.finishes.join(",")})`,
        });
      if (c.digital || !c.games?.includes("paper"))
        digital.push({ deck: d.name, line: e, printing_id: c.id });
      used.set(c.id, c);
      return {
        printing_id: c.id,
        quantity: e.quantity,
        finish: e.finish,
        section: names.some((n) => d.commander_names.includes(n))
          ? "commanders"
          : names.some((n) => d.companion_names.includes(n))
            ? "companions"
            : e.section,
      };
    })
    .filter(Boolean),
}));
for (let i = 0; i < decks.length; i++) {
  const commanders = manifests[i].entries.filter(
    (e) => e.section === "commanders",
  );
  if (commanders.length !== decks[i].commander_names.length)
    problems.push({
      deck: decks[i].name,
      reason:
        "Canonical commander count does not match the observed commander group.",
    });
}
writeFileSync(
  `${directory}/resolution-report.json`,
  JSON.stringify(
    {
      decks: manifests.map((d) => ({
        name: d.name,
        quantity: d.entries.reduce((n, e) => n + e.quantity, 0),
        excluded: d.excluded,
      })),
      problems,
      digital,
    },
    null,
    2,
  ),
);
writeFileSync(
  `${directory}/canonical-cards.json`,
  JSON.stringify([...used.values()]),
);
writeFileSync(
  `${directory}/resolved-manifest.json`,
  JSON.stringify(manifests, null, 2),
);
console.log(
  JSON.stringify(
    {
      decks: decks.length,
      printings: used.size,
      copies: manifests.reduce(
        (n, d) => n + d.entries.reduce((n, e) => n + e.quantity, 0),
        0,
      ),
      problems,
      digital,
    },
    null,
    2,
  ),
);
if (problems.length) process.exitCode = 1;
