/** Local provider implementations for the mocked-app half of the storybook. */

import type {
  CardRecord,
  CatalogEntry,
  CatalogReference,
  CatalogResolution,
  CatalogRevision,
  CatalogService,
  PrintingRecord,
} from '../src/catalog/index.js';
import type {
  Association,
  ImportEntry,
  ImportSession,
  PhysicalCopy,
  Tag,
  UserCardsFragmentsResult,
  UserCardsQueryPage,
  UserCardsReference,
} from '../src/usercards/index.js';
import {
  createUserCardsOperations,
  type UserCardsBrowserClient,
  type UserCardsOperations,
} from '../src/usercards/browser.js';
import { ManualProgression } from './progression.js';

const revision: CatalogRevision = {
  revisionId: 'local-catalog-1',
  sourceName: 'local-fixtures',
  sourceVersion: '1',
  publishedAt: '2026-10-02T00:00:00.000Z',
};

const cards: readonly CardRecord[] = [
  {
    cardId: 'lightning-bolt',
    name: 'Lightning Bolt',
    names: [],
    rulesText: 'Lightning Bolt deals 3 damage to any target.',
    typeLine: 'Instant',
    colors: ['R'],
    colorIdentity: ['R'],
    manaValue: 1,
  },
  {
    cardId: 'counterspell',
    name: 'Counterspell',
    names: [],
    rulesText: 'Counter target spell.',
    typeLine: 'Instant',
    colors: ['U'],
    colorIdentity: ['U'],
    manaValue: 2,
  },
];

const printings: readonly PrintingRecord[] = [
  {
    printingId: 'm11-149',
    cardId: 'lightning-bolt',
    edition: 'M11',
    collectorNumber: '149',
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: {
      small: './card-back.svg',
      normal: './card-back.svg',
      large: './card-back.svg',
      artCrop: './card-back.svg',
    },
  },
  {
    printingId: '2xm-47',
    cardId: 'counterspell',
    edition: '2XM',
    collectorNumber: '47',
    language: 'en',
    finishes: ['nonfoil'],
    physical: true,
    images: { small: null, normal: null, large: null, artCrop: null },
  },
];

const copies = new Map<string, PhysicalCopy>([
  [
    'copy-bolt-1',
    {
      copyId: 'copy-bolt-1',
      printingId: 'm11-149',
      finish: 'nonfoil',
      condition: 'LP',
      revision: 1,
    },
  ],
]);

export interface LocalProviders {
  readonly catalog: CatalogService;
  readonly userCards: UserCardsOperations;
}

export function createLocalProviders(progression: ManualProgression): LocalProviders {
  const mutableTags: Tag[] = [
    { tagId: 'tag-deck', kind: 'deck', label: 'Friday deck', system: false, revision: 1 },
    { tagId: 'tag-wishlist', kind: 'wishlist', label: 'Wishlist', system: false, revision: 1 },
  ];
  const associations: Association[] = [
    {
      associationId: 'association-bolt',
      tagId: 'tag-deck',
      targetLevel: 'card',
      targetId: 'lightning-bolt',
      quantity: 4,
      revision: 1,
    },
  ];
  const sessions: ImportSession[] = [];
  const entries: ImportEntry[] = [];
  let privateRevision = 1;
  let tagSequence = 2;

  const catalog: CatalogService = {
    query(input) {
      return progression.wait('Loading catalog results', () => {
        const resultLevel = input.resultLevel;
        const result: CatalogEntry[] =
          resultLevel === 'printing'
            ? printings.map((printing) => catalogEntry(printing))
            : cards.map((card) => ({
                entryKey: `card:${card.cardId}`,
                target: { kind: 'card', cardId: card.cardId },
                card: { ...card, matchedName: null },
                printing: null,
              }));
        return { entries: result, totalCount: result.length, revision, continuation: null };
      });
    },
    resolve(references) {
      return progression.wait('Loading card details', () => resolveCatalog(references));
    },
    listCardPrintings(cardId) {
      return progression.wait('Loading printing choices', () => ({
        cardId,
        cardExists: cards.some((card) => card.cardId === cardId),
        revision,
        printings: printings.filter((printing) => printing.cardId === cardId),
        continuation: null,
      }));
    },
  };

  const unavailable = (): Promise<never> =>
    progression.wait('Completing mock action', () => {
      throw new Error('This local fixture does not expose that operation in the current state.');
    });
  const client: UserCardsBrowserClient = {
    query(input) {
      return progression.wait('Loading collection results', () => privateQuery(input.resultLevel));
    },
    readFragments(input) {
      return progression.wait('Loading ownership and tags', () => fragments(input.references));
    },
    readPhysicalDetail(copyId) {
      return progression.wait('Loading copy details', () => {
        const copy = copies.get(copyId);
        if (copy === undefined) throw new Error('The local copy does not exist.');
        return {
          copy,
          memberships: associations.filter(
            (association) => association.targetLevel === 'copy' && association.targetId === copyId,
          ),
          privateRevision: String(privateRevision),
        };
      });
    },
    readCopies(copyIds) {
      return progression.wait('Loading copies', () => ({
        privateRevision: String(privateRevision),
        copies: new Map(copyIds.flatMap((id) => (copies.has(id) ? [[id, copies.get(id)!]] : []))),
        missing: copyIds.filter((id) => !copies.has(id)),
      }));
    },
    correctCopy: unavailable,
    listTags() {
      return progression.wait('Loading tags', () => ({
        privateRevision: String(privateRevision),
        tags: [...mutableTags],
        continuation: null,
      }));
    },
    readTags(tagIds) {
      return progression.wait('Loading tag details', () => ({
        privateRevision: String(privateRevision),
        tags: new Map(
          mutableTags.filter((tag) => tagIds.includes(tag.tagId)).map((tag) => [tag.tagId, tag]),
        ),
        missing: tagIds.filter((id) => !mutableTags.some((tag) => tag.tagId === id)),
      }));
    },
    createTag(input) {
      return progression.wait('Creating tag', () => {
        privateRevision += 1;
        tagSequence += 1;
        const tag: Tag = {
          tagId: `tag-local-${String(tagSequence)}`,
          kind: input.kind,
          label: input.label,
          system: false,
          revision: 1,
        };
        mutableTags.push(tag);
        return { privateRevision: String(privateRevision), tag };
      });
    },
    renameTag(input) {
      return progression.wait('Renaming tag', () => {
        const index = mutableTags.findIndex((tag) => tag.tagId === input.tagId);
        const previous = mutableTags[index];
        if (previous === undefined) throw new Error('The local tag no longer exists.');
        const tag = { ...previous, label: input.label, revision: previous.revision + 1 };
        mutableTags.splice(index, 1, tag);
        privateRevision += 1;
        return { privateRevision: String(privateRevision), tag };
      });
    },
    listAssociations(tagId) {
      return progression.wait('Loading tag cards', () => ({
        privateRevision: String(privateRevision),
        associations: associations.filter((association) => association.tagId === tagId),
        continuation: null,
      }));
    },
    readAssociations(ids) {
      return progression.wait('Loading associations', () => ({
        privateRevision: String(privateRevision),
        associations: new Map(
          associations
            .filter((item) => ids.includes(item.associationId))
            .map((item) => [item.associationId, item]),
        ),
        missing: ids.filter((id) => !associations.some((item) => item.associationId === id)),
      }));
    },
    createAssociation: unavailable,
    changeAssociation: unavailable,
    removeAssociation: unavailable,
    setCopyLocation: unavailable,
    listImportSessions() {
      return progression.wait('Loading pending imports', () => ({
        privateRevision: String(privateRevision),
        sessions: [...sessions],
        continuation: null,
      }));
    },
    listImportEntries(input) {
      return progression.wait('Loading pending entries', () => {
        const session = sessions.find((candidate) => candidate.sessionId === input.sessionId);
        if (session === undefined) throw new Error('The local import does not exist.');
        return {
          privateRevision: String(privateRevision),
          session,
          entries: entries.filter((entry) => entry.sessionId === input.sessionId),
          continuation: null,
        };
      });
    },
    stageImportEntries: unavailable,
    stageSourceImport: unavailable,
    stageCaptureObservation: unavailable,
    reviewImportEntry: unavailable,
    attachImportCandidates: unavailable,
    discardImportEntry: unavailable,
    discardImportSession: unavailable,
    confirmImport: unavailable,
    recoverImportOperation: () =>
      progression.wait('Checking the mock operation', () => ({ outcome: 'absent' as const })),
  };

  return {
    catalog,
    userCards: createUserCardsOperations({ client, storage: null }),
  };
}

function catalogEntry(printing: PrintingRecord): CatalogEntry {
  const card = cards.find((candidate) => candidate.cardId === printing.cardId)!;
  return {
    entryKey: `printing:${printing.printingId}`,
    target: { kind: 'printing', printingId: printing.printingId },
    card: { ...card, matchedName: null },
    printing,
  };
}

function resolveCatalog(references: readonly CatalogReference[]): CatalogResolution {
  const resolvedCards = new Map(cards.map((card) => [card.cardId, card]));
  const resolvedPrintings = new Map(printings.map((printing) => [printing.printingId, printing]));
  return {
    revision,
    cards: new Map(
      references.flatMap((reference) =>
        reference.kind === 'card' && resolvedCards.has(reference.cardId)
          ? [[reference.cardId, resolvedCards.get(reference.cardId)!]]
          : [],
      ),
    ),
    printings: new Map(
      references.flatMap((reference) =>
        reference.kind === 'printing' && resolvedPrintings.has(reference.printingId)
          ? [[reference.printingId, resolvedPrintings.get(reference.printingId)!]]
          : [],
      ),
    ),
    missing: references.filter((reference) =>
      reference.kind === 'card'
        ? !resolvedCards.has(reference.cardId)
        : !resolvedPrintings.has(reference.printingId),
    ),
  };
}

function privateQuery(level: 'card' | 'printing' | 'copy'): UserCardsQueryPage {
  const target =
    level === 'card'
      ? { kind: 'card' as const, cardId: 'lightning-bolt' }
      : level === 'printing'
        ? { kind: 'printing' as const, printingId: 'm11-149' }
        : { kind: 'copy' as const, copyId: 'copy-bolt-1' };
  return {
    entries: [
      {
        entryKey: referenceKey(target),
        target,
        ownedCopyCount: 1,
        intendedQuantity: 4,
        physicalLocationCount: 0,
        directAssociationCount: 1,
        derivedAssociationCount: 0,
      },
    ],
    totalCount: 1,
    privateRevision: '1',
    continuation: null,
  };
}

function fragments(references: readonly UserCardsReference[]): UserCardsFragmentsResult {
  const result = new Map<
    string,
    UserCardsFragmentsResult['fragments'] extends ReadonlyMap<string, infer Value> ? Value : never
  >();
  for (const reference of references) {
    const key = referenceKey(reference);
    const id = key.slice(key.indexOf(':') + 1);
    result.set(key, {
      reference,
      ownedCopyCount:
        reference.kind === 'copy' || id === 'lightning-bolt' || id === 'm11-149' ? 1 : 0,
      tagIds: id === 'lightning-bolt' ? ['tag-deck'] : [],
      physicalLocationCount: 0,
      intendedQuantity: id === 'lightning-bolt' ? 4 : null,
    });
  }
  return { privateRevision: '1', fragments: result, missing: [] };
}

function referenceKey(reference: UserCardsReference): string {
  switch (reference.kind) {
    case 'card':
      return `card:${reference.cardId}`;
    case 'printing':
      return `printing:${reference.printingId}`;
    case 'copy':
      return `copy:${reference.copyId}`;
  }
}
