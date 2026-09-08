// Administrator-only verification setup. No endpoint exposes this synthetic
// provider in the app. This seeds ONLY the reserved keeper-import test account.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createDynamoAdapters } from "../adapters/dynamo.js";
import { createDynamoDocumentStore } from "../adapters/document-store.js";
import { createScryfallCatalog } from "../adapters/scryfall.js";
import { createCollectionService } from "../application/collection.js";
import { createTaggedCollection } from "../application/tagged-collection.js";
import { createImportDraftService } from "../application/import-drafts.js";
import { moxfieldSource } from "../domain/import-draft.js";
const outputs = JSON.parse(readFileSync("infra/outputs.json"));
const user = JSON.parse(
  execFileSync(
    "aws",
    [
      "cognito-idp",
      "admin-get-user",
      "--user-pool-id",
      outputs.UserPoolId,
      "--username",
      "keeper-import",
    ],
    { stdio: "pipe" },
  ),
);
const attrs = Object.fromEntries(
  user.UserAttributes.map((a) => [a.Name, a.Value]),
);
if (
  user.Username !== "keeper-import" ||
  attrs.email !== "keeper-import@example.invalid" ||
  !attrs.sub
)
  throw Error("Reserved test identity verification failed");
const owner = attrs.sub,
  adapters = createDynamoAdapters("magic-collection-keeper"),
  catalog = createScryfallCatalog(adapters),
  store = createDynamoDocumentStore("magic-collection-keeper");
const tagged = createTaggedCollection({
  collection: createCollectionService({
    repository: adapters.repository,
    catalog,
  }),
  repository: adapters.repository,
  store,
  newId: randomUUID,
  hash: (s) => createHash("sha256").update(s).digest("hex"),
});
const search = await catalog.search('!"Lightning Bolt" set:m11 lang:en', 1);
const card = search.cards[0];
if (!card?.finishes.includes("foil") || !card.finishes.includes("nonfoil"))
  throw Error("Test printing unavailable");
const url = "https://moxfield.com/decks/keeper_import_live_v1";
const service = createImportDraftService({
  store,
  catalog,
  repository: adapters.repository,
  collection: tagged,
  newId: randomUUID,
  provider: {
    fetchDeck: async () => ({
      ...moxfieldSource(url),
      name: "Synthetic persistent import fixture",
      retrieved_at: new Date().toISOString(),
      excluded: [{ section: "sideboard", quantity: 1 }],
      rows: [
        { quantity: 99, finish: "nonfoil" },
        { quantity: 1, finish: "foil" },
      ].map((line, i) => ({
        ...line,
        source_line: `mainboard:${i}`,
        section: "mainboard",
        name: card.name,
        printing_id: card.id,
        set: card.set,
        collector_number: card.collector_number,
        language: card.lang,
      })),
    }),
  },
});
const before = await tagged.list(owner);
const current = await service.getDraft(owner);
if (current.draft) {
  if (current.draft.source_id !== moxfieldSource(url).source_id)
    throw Error(
      "A different test draft is active; inspect before replacing it",
    );
  await service.clearDraft(owner, {
    id: current.draft.id,
    version: current.draft.version,
  });
}
const result = await service.fetchDraft(owner, { url });
const after = await tagged.list(owner);
if (JSON.stringify(before) !== JSON.stringify(after))
  throw Error("Seeding changed owned inventory");
console.log(
  JSON.stringify({
    testProfile: "keeper-import",
    draftId: result.draft.id,
    version: result.draft.version,
    copies: result.summary.reviewed_copies,
    ownedUnchanged: true,
    provider: "synthetic test port, not a live Moxfield fetch",
  }),
);
