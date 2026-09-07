// Administrator workflow: canonical catalog data is not ownership until a source
// manifest is committed through the same application port as the protected API.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createDynamoAdapters } from "../adapters/dynamo.js";
import { createDynamoDocumentStore } from "../adapters/document-store.js";
import { createCollectionService } from "../application/collection.js";
import { createTaggedCollection } from "../application/tagged-collection.js";

const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
for (const name of [
  "--username",
  "--email",
  "--manifest",
  "--cards",
  "--folder",
])
  if (
    !args.includes(name) ||
    !argument(name) ||
    argument(name).startsWith("--")
  )
    throw new Error(`Required argument: ${name}`);
const outputs = JSON.parse(readFileSync("infra/outputs.json"));
const account = JSON.parse(
  execFileSync(
    "aws",
    [
      "cognito-idp",
      "admin-get-user",
      "--user-pool-id",
      outputs.UserPoolId,
      "--username",
      argument("--username"),
      "--region",
      "us-east-1",
    ],
    { stdio: "pipe" },
  ),
);
const attributes = Object.fromEntries(
  account.UserAttributes.map((a) => [a.Name, a.Value]),
);
if (
  !account.Enabled ||
  attributes.email !== argument("--email") ||
  !attributes.sub
)
  throw new Error("The authorized owner could not be verified.");
const owner = attributes.sub;
const manifest = JSON.parse(readFileSync(argument("--manifest")));
if (
  !Array.isArray(manifest) ||
  !manifest.length ||
  manifest.some((d) => d.folder !== argument("--folder"))
)
  throw new Error(
    "Manifest must contain only decks from the verified requested folder.",
  );
if (new Set(manifest.map((d) => d.source_id)).size !== manifest.length)
  throw new Error("Duplicate source IDs in manifest.");
const cards = JSON.parse(readFileSync(argument("--cards")));
const adapters = createDynamoAdapters("magic-collection-keeper");
const canonicalById = new Map(cards.map((card) => [card.id, card]));
const repository = {
  ...adapters.repository,
  getPrinting: async (id) =>
    canonicalById.get(id) ?? adapters.repository.getPrinting(id),
};
const store = createDynamoDocumentStore("magic-collection-keeper");
const service = createTaggedCollection({
  collection: createCollectionService({
    repository,
    catalog: {},
  }),
  repository,
  store,
  newId: randomUUID,
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
const before = await service.list(owner);
const nativeBefore = await adapters.repository.list(owner);
const preview = [];
for (const deck of manifest)
  preview.push({
    name: deck.name,
    url: deck.url,
    ...(await service.previewDeck(owner, deck)),
  });
mkdirSync("data/imports", { recursive: true });
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
writeFileSync(
  `data/imports/preview-${stamp}.json`,
  JSON.stringify({ before, preview }, null, 2),
);
console.log(
  JSON.stringify(
    { mode: args.includes("--apply") ? "apply" : "preview", decks: preview },
    null,
    2,
  ),
);
if (args.includes("--apply")) {
  const printingIds = new Set(
    manifest.flatMap((d) => d.entries.map((e) => e.printing_id)),
  );
  const selected = cards.filter((c) => printingIds.has(c.id));
  if (selected.length !== printingIds.size)
    throw new Error("Canonical printing metadata is incomplete.");
  const results = [];
  for (const deck of manifest) {
    const current = await service.previewDeck(owner, deck);
    results.push({
      name: deck.name,
      ...(await service.importDeck(owner, {
        ...deck,
        expected_version: current.existing_version,
      })),
    });
    console.log(JSON.stringify({ imported: deck.name, ...results.at(-1) }));
  }
  const after = await service.list(owner);
  const nativeAfter = await adapters.repository.list(owner);
  if (JSON.stringify(nativeBefore) !== JSON.stringify(nativeAfter))
    throw new Error(
      "Loose inventory changed during import. Inspect the saved preview.",
    );
  for (const deck of manifest) {
    const repeat = await service.previewDeck(owner, deck);
    if (!repeat.unchanged || repeat.additions !== 0)
      throw new Error("Repeat import verification failed.");
  }
  const report = {
    at: new Date().toISOString(),
    results,
    beforeCopies: before.reduce((n, r) => n + r.quantity, 0),
    afterCopies: after.reduce((n, r) => n + r.quantity, 0),
    entries: after.length,
    nativeInventoryUnchanged: true,
    repeatImportAdditions: 0,
  };
  writeFileSync(
    `data/imports/result-${stamp}.json`,
    JSON.stringify({ ...report, after }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
