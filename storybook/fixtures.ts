/** Local provider implementations for the mocked-app half of the storybook. */

import {
  parseCatalogQuery,
  readCatalogCriterion,
  CatalogError,
  type CatalogFilter,
} from '../src/catalog/browser.js';
import type { CardListBrowser } from '../src/card-list/index.js';
import { createLocalCardList } from './card-list.js';

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

export interface LocalProviders {
  readonly cardList: CardListBrowser;
  readonly catalog: CatalogService;
  readonly userCards: UserCardsOperations;
  /** Immediate copy dependencies for editor-owned action gates. */
  readonly copyActions: UserCardsOperations;
}

export function createLocalProviders(progression: ManualProgression): LocalProviders {
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
  const mutableTags: Tag[] = [
    { tagId: 'tag-deck', kind: 'deck', label: 'Friday deck', system: false, revision: 1 },
    { tagId: 'tag-wishlist', kind: 'wishlist', label: 'Wishlist', system: false, revision: 1 },
    { tagId: 'tag-binder', kind: 'location', label: 'Trade binder', system: false, revision: 1 },
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
  let associationSequence = 1;
  let copySequence = 1;
  const tagsRead = sharedRead(progression);
  const sessionsRead = sharedRead(progression);
  const receipts = new Map<string, import('../src/usercards/index.js').ImportReceipt>();
  const changeEntry = (entryId: string, change: (entry: ImportEntry) => ImportEntry) => {
    const index = entries.findIndex((entry) => entry.entryId === entryId);
    const previous = entries[index];
    if (previous === undefined) throw new Error('The local import entry no longer exists.');
    const entry = change(previous);
    entries.splice(index, 1, entry);
    const session = sessions.find((item) => item.sessionId === entry.sessionId);
    if (session === undefined) throw new Error('The local import no longer exists.');
    privateRevision += 1;
    return {
      privateRevision: String(privateRevision),
      session: refreshSession(session, entries),
      entry,
    };
  };

  const catalog: CatalogService = {
    query(input, signal) {
      return progression.wait(
        'Loading catalog results',
        () => {
          const filters: CatalogFilter[] = [];
          if (input.query?.trim()) filters.push(parseCatalogQuery(input.query));
          for (const value of input.criteria ?? []) {
            const criterion = readCatalogCriterion(value);
            if (!criterion.ok) throw new CatalogError('invalid-request', criterion.problem);
            filters.push({ kind: 'criterion', criterion: criterion.criterion });
          }
          const matchingPrintings = printings.filter((printing) =>
            filters.every((filter) => catalogMatches(filter, printing)),
          );
          const matchingCards = new Set(matchingPrintings.map((printing) => printing.cardId));
          const result: CatalogEntry[] =
            input.resultLevel === 'printing'
              ? matchingPrintings.map((printing) => catalogEntry(printing))
              : cards
                  .filter((card) => matchingCards.has(card.cardId))
                  .map((card) => ({
                    entryKey: `card:${card.cardId}`,
                    target: { kind: 'card', cardId: card.cardId },
                    card: { ...card, matchedName: null },
                    printing: null,
                  }));
          return { entries: result, totalCount: result.length, revision, continuation: null };
        },
        signal,
      );
    },
    async resolve(references) {
      return resolveCatalog(references);
    },
    async listCardPrintings(cardId) {
      return {
        cardId,
        cardExists: cards.some((card) => card.cardId === cardId),
        revision,
        printings: printings.filter((printing) => printing.cardId === cardId),
        continuation: null,
      };
    },
  };

  const correctLocalCopy = (input: Parameters<UserCardsBrowserClient['correctCopy']>[0]) => {
    const previous = copies.get(input.copyId);
    if (previous === undefined) throw new Error('The local copy no longer exists.');
    const copy: PhysicalCopy = {
      copyId: previous.copyId,
      printingId: input.printingId,
      finish: input.finish,
      condition: input.condition,
      revision: previous.revision + 1,
    };
    copies.set(copy.copyId, copy);
    privateRevision += 1;
    return { privateRevision: String(privateRevision), copies: [copy] };
  };

  const client: UserCardsBrowserClient = {
    query(input, signal) {
      return progression.wait(
        'Loading collection results',
        () => privateQuery(input, copies, associations, mutableTags, privateRevision),
        signal,
      );
    },
    readFragments(input, signal) {
      return progression.wait(
        'Loading ownership and tags',
        () =>
          fragments(
            input.references,
            copies,
            associations,
            mutableTags,
            privateRevision,
            input.tagId,
          ),
        signal,
      );
    },
    readPhysicalDetail(copyId, signal) {
      return progression.wait(
        'Loading copy details',
        () => {
          const copy = copies.get(copyId);
          if (copy === undefined) throw new Error('The local copy does not exist.');
          return {
            copy,
            memberships: associations.filter(
              (association) =>
                association.targetLevel === 'copy' && association.targetId === copyId,
            ),
            privateRevision: String(privateRevision),
          };
        },
        signal,
      );
    },
    async readCopies(copyIds) {
      return {
        privateRevision: String(privateRevision),
        copies: new Map(copyIds.flatMap((id) => (copies.has(id) ? [[id, copies.get(id)!]] : []))),
        missing: copyIds.filter((id) => !copies.has(id)),
      };
    },
    correctCopy(input, signal) {
      return progression.wait('Saving copy changes', () => correctLocalCopy(input), signal);
    },
    listTags(_options, signal) {
      return tagsRead(
        'Loading tags',
        () => ({
          privateRevision: String(privateRevision),
          tags: [...mutableTags],
          continuation: null,
        }),
        signal,
      );
    },
    readTags(tagIds, signal) {
      return progression.wait(
        'Loading tag details',
        () => ({
          privateRevision: String(privateRevision),
          tags: new Map(
            mutableTags.filter((tag) => tagIds.includes(tag.tagId)).map((tag) => [tag.tagId, tag]),
          ),
          missing: tagIds.filter((id) => !mutableTags.some((tag) => tag.tagId === id)),
        }),
        signal,
      );
    },
    createTag(input, signal) {
      return progression.wait(
        'Creating tag',
        () => {
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
        },
        signal,
      );
    },
    renameTag(input, signal) {
      return progression.wait(
        'Renaming tag',
        () => {
          const index = mutableTags.findIndex((tag) => tag.tagId === input.tagId);
          const previous = mutableTags[index];
          if (previous === undefined) throw new Error('The local tag no longer exists.');
          const tag = { ...previous, label: input.label, revision: previous.revision + 1 };
          mutableTags.splice(index, 1, tag);
          privateRevision += 1;
          return { privateRevision: String(privateRevision), tag };
        },
        signal,
      );
    },
    listAssociations(tagId, _options, signal) {
      return progression.wait(
        'Loading tag cards',
        () => ({
          privateRevision: String(privateRevision),
          associations: associations.filter((association) => association.tagId === tagId),
          continuation: null,
        }),
        signal,
      );
    },
    readAssociations(ids, signal) {
      return progression.wait(
        'Loading associations',
        () => ({
          privateRevision: String(privateRevision),
          associations: new Map(
            associations
              .filter((item) => ids.includes(item.associationId))
              .map((item) => [item.associationId, item]),
          ),
          missing: ids.filter((id) => !associations.some((item) => item.associationId === id)),
        }),
        signal,
      );
    },
    createAssociation(input, signal) {
      return progression.wait(
        'Adding tag card',
        () => {
          const association: Association = {
            associationId: `association-local-${String(++associationSequence)}`,
            tagId: input.tagId,
            targetLevel: input.targetLevel,
            targetId: input.targetId,
            quantity: input.targetLevel === 'copy' ? null : (input.quantity ?? 1),
            revision: 1,
          };
          associations.push(association);
          privateRevision += 1;
          return { privateRevision: String(privateRevision), association };
        },
        signal,
      );
    },
    changeAssociation(input, signal) {
      return progression.wait(
        'Saving tag card',
        () => {
          const index = associations.findIndex(
            (item) => item.associationId === input.associationId,
          );
          const previous = associations[index];
          if (previous === undefined) throw new Error('The local association no longer exists.');
          const association: Association = {
            ...previous,
            targetLevel: input.targetLevel,
            targetId: input.targetId,
            quantity: input.targetLevel === 'copy' ? null : (input.quantity ?? 1),
            revision: previous.revision + 1,
          };
          associations.splice(index, 1, association);
          privateRevision += 1;
          return { privateRevision: String(privateRevision), association };
        },
        signal,
      );
    },
    removeAssociation(input, signal) {
      return progression.wait(
        'Removing tag card',
        () => {
          const index = associations.findIndex(
            (item) => item.associationId === input.associationId,
          );
          if (index < 0) throw new Error('The local association no longer exists.');
          associations.splice(index, 1);
          privateRevision += 1;
          return { privateRevision: String(privateRevision), associationId: input.associationId };
        },
        signal,
      );
    },
    setCopyLocation(input, signal) {
      return progression.wait(
        'Moving copy',
        () => {
          const previous = copies.get(input.copyId);
          if (previous === undefined) throw new Error('The local copy no longer exists.');
          for (let index = associations.length - 1; index >= 0; index -= 1) {
            const item = associations[index];
            const tag = mutableTags.find((candidate) => candidate.tagId === item?.tagId);
            if (
              item?.targetLevel === 'copy' &&
              item.targetId === input.copyId &&
              tag?.kind === 'location'
            ) {
              associations.splice(index, 1);
            }
          }
          const copy = { ...previous, revision: previous.revision + 1 };
          copies.set(copy.copyId, copy);
          const location: Association | null =
            input.locationTagId === null
              ? null
              : {
                  associationId: `association-local-${String(++associationSequence)}`,
                  tagId: input.locationTagId,
                  targetLevel: 'copy',
                  targetId: input.copyId,
                  quantity: null,
                  revision: 1,
                };
          if (location !== null) associations.push(location);
          privateRevision += 1;
          return { privateRevision: String(privateRevision), copy, location };
        },
        signal,
      );
    },
    listImportSessions(_options, signal) {
      return sessionsRead(
        'Loading pending imports',
        () => ({
          privateRevision: String(privateRevision),
          sessions: sessions
            .map((session) => refreshSession(session, entries))
            .filter((session) => session.pendingEntries > 0),
          continuation: null,
        }),
        signal,
      );
    },
    listImportEntries(input, signal) {
      return progression.wait(
        'Loading pending entries',
        () => {
          const session = sessions.find((candidate) => candidate.sessionId === input.sessionId);
          if (session === undefined) throw new Error('The local import does not exist.');
          return {
            privateRevision: String(privateRevision),
            session: refreshSession(session, entries),
            entries: entries.filter(
              (entry) => entry.sessionId === input.sessionId && entry.state === 'pending',
            ),
            continuation: null,
          };
        },
        signal,
      );
    },
    stageImportEntries(input, signal) {
      return progression.wait(
        'Adding cards to review',
        () => {
          const session = ensureSession(
            sessions,
            input.sessionId,
            input.source.kind,
            input.source.id,
            input.source.reference ?? null,
          );
          const staged: ImportEntry[] = [];
          for (const candidate of input.entries) {
            if (entries.some((entry) => entry.entryId === candidate.entryId)) continue;
            const printing = printings.find((item) => item.printingId === candidate.printingId);
            const entry: ImportEntry = {
              entryId: candidate.entryId,
              sessionId: input.sessionId,
              position: entries.filter((item) => item.sessionId === input.sessionId).length + 1,
              state: 'pending',
              cardId: printing?.cardId ?? null,
              printingId: printing?.printingId ?? null,
              finish: candidate.finish ?? printing?.finishes[0] ?? null,
              condition: candidate.condition ?? null,
              quantity: candidate.quantity,
              candidates: candidate.candidates ?? [],
              sourceLine: null,
              revision: 1,
            };
            entries.push(entry);
            staged.push(entry);
          }
          privateRevision += 1;
          return {
            privateRevision: String(privateRevision),
            session: refreshSession(session, entries),
            entries: staged,
            staged: staged.length,
            replayed: staged.length === 0,
          };
        },
        signal,
      );
    },
    stageSourceImport(input, signal) {
      return progression.wait(
        'Importing source cards',
        () => {
          const session = ensureSession(
            sessions,
            input.sessionId,
            input.format,
            input.format === 'wizards-precon' ? input.sourceId : input.sessionId,
            input.format === 'moxfield'
              ? input.url
              : input.format === 'wizards-precon'
                ? input.reference
                : null,
          );
          const sourceLines =
            input.format === 'pasted-list'
              ? input.text
                  .split(/\r?\n/u)
                  .filter((line) => line.trim() !== '')
                  .map((line) => {
                    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
                    return { name: match?.[2] ?? line.trim(), quantity: Number(match?.[1] ?? 1) };
                  })
              : input.format === 'wizards-precon'
                ? input.entries.map((line) => ({ name: line.name, quantity: line.quantity }))
                : [{ name: 'Lightning Bolt', quantity: 1 }];
          const rows: import('../src/usercards/index.js').SourceImportRow[] = [];
          for (const [index, line] of sourceLines.entries()) {
            const card = cards.find((item) => item.name.toLowerCase() === line.name.toLowerCase());
            const printing = printings.find((item) => item.cardId === card?.cardId);
            const entryId = `${input.sessionId}-line-${String(index + 1)}`;
            const existing = entries.find((entry) => entry.entryId === entryId);
            if (existing === undefined)
              entries.push({
                entryId,
                sessionId: input.sessionId,
                position: entries.filter((entry) => entry.sessionId === input.sessionId).length + 1,
                state: 'pending',
                cardId: card?.cardId ?? null,
                printingId: printing?.printingId ?? null,
                finish: printing?.finishes[0] ?? null,
                condition: null,
                quantity: line.quantity,
                candidates: [],
                revision: 1,
                sourceLine: {
                  printingId: printing?.printingId ?? null,
                  name: line.name,
                  section: null,
                  set: printing?.edition ?? null,
                  collectorNumber: printing?.collectorNumber ?? null,
                  language: printing?.language ?? null,
                  finish: printing?.finishes[0] ?? null,
                  declaredQuantity: line.quantity,
                  problem: printing === undefined ? 'Choose a published printing.' : null,
                },
              });
            rows.push({
              position: index + 1,
              line: entries.find((entry) => entry.entryId === entryId)?.sourceLine ?? null,
              outcome: existing === undefined ? 'staged' : 'pending',
              problem: printing === undefined ? 'Choose a published printing.' : null,
              entryId,
              sessionId: input.sessionId,
            });
          }
          privateRevision += 1;
          return {
            privateRevision: String(privateRevision),
            session: refreshSession(session, entries),
            rows,
            staged: rows.filter((row) => row.outcome === 'staged').length,
          };
        },
        signal,
      );
    },
    stageCaptureObservation(input, signal) {
      return progression.wait(
        'Adding captured card to review',
        () => {
          const session = ensureSession(
            sessions,
            input.sessionId,
            'capture',
            input.sessionId,
            null,
          );
          const existing = entries.find((entry) => entry.entryId === input.captureId);
          if (existing !== undefined)
            return {
              privateRevision: String(privateRevision),
              outcome: 'suppressed' as const,
              replayed: true,
              session: refreshSession(session, entries),
              entry: null,
            };
          const printing = printings.find((item) => item.printingId === input.printingId);
          const entry: ImportEntry | null =
            printing === undefined
              ? null
              : {
                  entryId: input.captureId,
                  sessionId: input.sessionId,
                  position: entries.filter((item) => item.sessionId === input.sessionId).length + 1,
                  state: 'pending',
                  cardId: printing.cardId,
                  printingId: printing.printingId,
                  finish: input.finish ?? printing.finishes[0] ?? null,
                  condition: null,
                  quantity: 1,
                  candidates: input.candidates ?? [],
                  sourceLine: null,
                  revision: 1,
                };
          if (entry !== null) entries.push(entry);
          privateRevision += 1;
          return {
            privateRevision: String(privateRevision),
            outcome: entry === null ? ('unresolved' as const) : ('admitted' as const),
            replayed: false,
            session: refreshSession(session, entries),
            entry,
          };
        },
        signal,
      );
    },
    reviewImportEntry(input, signal) {
      return progression.wait(
        'Saving import review',
        () =>
          changeEntry(input.entryId, (entry) => ({
            ...entry,
            cardId:
              input.cardId ??
              printings.find((item) => item.printingId === input.printingId)?.cardId ??
              null,
            printingId: input.printingId,
            finish: input.finish,
            condition: input.condition,
            quantity: input.quantity,
            revision: entry.revision + 1,
          })),
        signal,
      );
    },
    attachImportCandidates(input, signal) {
      return progression.wait(
        'Saving capture alternatives',
        () =>
          changeEntry(input.entryId, (entry) => ({
            ...entry,
            candidates: [...entry.candidates, ...input.candidates],
            revision: entry.revision + 1,
          })),
        signal,
      );
    },
    discardImportEntry(input, signal) {
      return progression.wait(
        'Discarding import entry',
        () =>
          changeEntry(input.entryId, (entry) => ({
            ...entry,
            state: 'discarded',
            revision: entry.revision + 1,
          })),
        signal,
      );
    },
    discardImportSession(input, signal) {
      return progression.wait(
        'Discarding import',
        () => {
          const session = sessions.find((item) => item.sessionId === input.sessionId);
          if (session === undefined) throw new Error('The local import no longer exists.');
          for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry?.sessionId === input.sessionId && entry.state === 'pending') {
              entries[index] = { ...entry, state: 'discarded', revision: entry.revision + 1 };
            }
          }
          privateRevision += 1;
          return {
            privateRevision: String(privateRevision),
            session: refreshSession(session, entries),
          };
        },
        signal,
      );
    },
    confirmImport(input, signal) {
      return progression.wait(
        'Confirming import',
        () => {
          const recorded = receipts.get(input.operationId);
          if (recorded !== undefined)
            return { ...recorded, privateRevision: String(privateRevision), replayed: true };
          const session = sessions.find((item) => item.sessionId === input.sessionId);
          if (session === undefined) throw new Error('The local import no longer exists.');
          const madeCopies: PhysicalCopy[] = [];
          const madeAssociations: Association[] = [];
          for (const wanted of input.entries) {
            const index = entries.findIndex((entry) => entry.entryId === wanted.entryId);
            const entry = entries[index];
            if (entry === undefined || entry.state !== 'pending') continue;
            if (input.destination.kind === 'ownership' && entry.printingId !== null) {
              for (let count = 0; count < entry.quantity; count += 1) {
                const copy: PhysicalCopy = {
                  copyId: `copy-local-${String(++copySequence)}`,
                  printingId: entry.printingId,
                  finish: entry.finish ?? 'nonfoil',
                  condition: entry.condition,
                  revision: 1,
                };
                copies.set(copy.copyId, copy);
                madeCopies.push(copy);
              }
            } else if (input.destination.kind === 'tag' && entry.cardId !== null) {
              const association: Association = {
                associationId: `association-local-${String(++associationSequence)}`,
                tagId: input.destination.tagId,
                targetLevel: entry.printingId === null ? 'card' : 'printing',
                targetId: entry.printingId ?? entry.cardId,
                quantity: entry.quantity,
                revision: 1,
              };
              associations.push(association);
              madeAssociations.push(association);
            }
            entries[index] = { ...entry, state: 'confirmed', revision: entry.revision + 1 };
          }
          const receipt: import('../src/usercards/index.js').ImportReceipt = {
            operationId: input.operationId,
            sessionId: input.sessionId,
            sourceKind: session.sourceKind,
            sourceId: session.sourceId,
            destination: input.destination,
            copies: madeCopies,
            associations: madeAssociations,
          };
          receipts.set(input.operationId, receipt);
          privateRevision += 1;
          return { ...receipt, privateRevision: String(privateRevision), replayed: false };
        },
        signal,
      );
    },
    recoverImportOperation: (operationId, signal) =>
      progression.wait(
        'Checking the mock operation',
        () => {
          const receipt = receipts.get(operationId);
          return receipt === undefined
            ? ({ outcome: 'absent' } as const)
            : ({ outcome: 'recorded', receipt } as const);
        },
        signal,
      ),
  };

  const userCards = createUserCardsOperations({
    client: {
      ...client,
      readCopies: (ids, signal) =>
        progression.wait('Loading physical copies', () => client.readCopies(ids, signal), signal),
    },
    storage: null,
  });
  const copyActions = createUserCardsOperations({
    client: { ...client, correctCopy: async (input) => correctLocalCopy(input) },
    storage: null,
  });
  // CardList's visible sources own their gates; dependent record resolution is immediate.
  const cardList = createLocalCardList(
    {
      catalog,
      userCards: {
        account: (accountId) => ({
          ...userCards.account(accountId),
          readCopies: client.readCopies,
          subscribe(listener) {
            const normal = userCards.account(accountId).subscribe(listener);
            const bulk = copyActions.account(accountId).subscribe(listener);
            return () => {
              normal();
              bulk();
            };
          },
        }),
      },
    },
    progression,
  );
  return { catalog, userCards, cardList, copyActions };
}

/** Identical reads within one view share its pending completion, including repeated refreshes. */
function sharedRead(progression: ManualProgression) {
  const reads = new Map<AbortSignal | undefined, Promise<unknown>>();
  return <Value>(label: string, complete: () => Value, signal?: AbortSignal): Promise<Value> => {
    const pending = reads.get(signal);
    if (pending !== undefined) return pending as Promise<Value>;
    const read = progression.wait(label, complete, signal).finally(() => reads.delete(signal));
    reads.set(signal, read);
    return read;
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

function catalogMatches(filter: CatalogFilter, printing: PrintingRecord): boolean {
  switch (filter.kind) {
    case 'and':
      return filter.operands.every((operand) => catalogMatches(operand, printing));
    case 'or':
      return filter.operands.some((operand) => catalogMatches(operand, printing));
    case 'not':
      return !catalogMatches(filter.operand, printing);
    case 'criterion':
      break;
  }
  const criterion = filter.criterion;
  const card = cards.find((candidate) => candidate.cardId === printing.cardId)!;
  const includes = (value: string, wanted: string) =>
    value.toLowerCase().includes(wanted.toLowerCase());
  switch (criterion.kind) {
    case 'name':
      return [card.name, ...card.names.map((name) => name.name)].some((name) =>
        includes(name, criterion.text),
      );
    case 'rulesText':
      return includes(card.rulesText ?? '', criterion.text);
    case 'type':
      return includes(card.typeLine ?? '', criterion.text);
    case 'set':
      return printing.edition.toLowerCase() === criterion.edition.toLowerCase();
    case 'language':
      return printing.language === criterion.language;
    case 'finish':
      return printing.finishes.includes(criterion.finish);
    case 'manaValue':
      return numericComparison(card.manaValue ?? 0, criterion.value, criterion.comparison);
    case 'color':
      return setComparison(card.colors, criterion.colors, criterion.comparison);
    case 'colorIdentity':
      return setComparison(card.colorIdentity, criterion.colors, criterion.comparison);
  }
}

function numericComparison(left: number, right: number, comparison: string): boolean {
  if (comparison === '=') return left === right;
  if (comparison === '!=') return left !== right;
  if (comparison === '>') return left > right;
  if (comparison === '>=') return left >= right;
  if (comparison === '<') return left < right;
  return left <= right;
}

function setComparison(
  left: readonly string[],
  right: readonly string[],
  comparison: string,
): boolean {
  const contains = right.every((value) => left.includes(value));
  const equal = contains && left.every((value) => right.includes(value));
  if (comparison === '=') return equal;
  if (comparison === '!=') return !equal;
  if (comparison === '>' || comparison === '>=') return contains && (comparison === '>=' || !equal);
  const subset = left.every((value) => right.includes(value));
  return subset && (comparison === '<=' || !equal);
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

function privateQuery(
  input: import('../src/usercards/index.js').UserCardsQueryInput,
  copies: ReadonlyMap<string, PhysicalCopy>,
  associations: readonly Association[],
  tags: readonly Tag[],
  privateRevision: number,
): UserCardsQueryPage {
  const scopeTagId = input.scope.kind === 'tag' ? input.scope.tagId : null;
  const targets = privateTargets(input.resultLevel, copies, associations).filter((target) => {
    const related = associations.filter((item) => associationMatches(target, item, copies));
    const owned = copiesFor(target, copies);
    if (input.scope.kind === 'collection' && owned.length === 0) return false;
    if (
      scopeTagId !== null &&
      !related.some(
        (item) => item.tagId === scopeTagId && associationContributes(target, item, copies),
      )
    )
      return false;
    return (input.criteria ?? []).every((criterion) => {
      switch (criterion.kind) {
        case 'identity':
          return criterion.references.some((reference) => sameHierarchy(target, reference, copies));
        case 'owned':
          return criterion.value === owned.length > 0;
        case 'tag':
          return related.some((item) => item.tagId === criterion.tagId);
        case 'location':
          return related.some(
            (item) =>
              item.tagId === criterion.tagId &&
              tags.find((tag) => tag.tagId === item.tagId)?.kind === 'location',
          );
        case 'finish':
          return (
            owned.some((copy) => copy.finish === criterion.finish) ||
            (target.kind === 'printing' &&
              printings
                .find((item) => item.printingId === target.printingId)
                ?.finishes.includes(criterion.finish) === true)
          );
        case 'condition':
          return owned.some((copy) => copy.condition === criterion.condition);
      }
    });
  });
  const result = targets.map((target) => {
    const related = associations.filter((item) => associationContributes(target, item, copies));
    const locationTags = related.filter(
      (item) => tags.find((tag) => tag.tagId === item.tagId)?.kind === 'location',
    );
    return {
      entryKey: referenceKey(target),
      target,
      ownedCopyCount: copiesFor(target, copies).length,
      intendedQuantity:
        scopeTagId !== null
          ? intendedQuantity(related.filter((item) => item.tagId === scopeTagId))
          : null,
      physicalLocationCount: new Set(locationTags.map((item) => item.tagId)).size,
      directAssociationCount: related.length,
      derivedAssociationCount: 0,
    };
  });
  return {
    entries: result,
    totalCount: result.length,
    privateRevision: String(privateRevision),
    continuation: null,
  };
}

function privateTargets(
  level: import('../src/usercards/index.js').UserCardsResultLevel,
  copies: ReadonlyMap<string, PhysicalCopy>,
  associations: readonly Association[],
): UserCardsReference[] {
  if (level === 'copy') return [...copies.keys()].map((copyId) => ({ kind: 'copy', copyId }));
  const printingIds = new Set([...copies.values()].map((copy) => copy.printingId));
  const cardIds = new Set<string>();
  for (const item of associations) {
    if (item.targetLevel === 'card') cardIds.add(item.targetId);
    if (item.targetLevel === 'printing') printingIds.add(item.targetId);
    if (item.targetLevel === 'copy') {
      const printingId = copies.get(item.targetId)?.printingId;
      if (printingId !== undefined) printingIds.add(printingId);
    }
  }
  for (const printingId of printingIds) {
    const cardId = printings.find((item) => item.printingId === printingId)?.cardId;
    if (cardId !== undefined) cardIds.add(cardId);
  }
  return level === 'printing'
    ? [...printingIds].map((printingId) => ({ kind: 'printing', printingId }))
    : [...cardIds].map((cardId) => ({ kind: 'card', cardId }));
}

function hierarchy(reference: UserCardsReference, copies: ReadonlyMap<string, PhysicalCopy>) {
  if (reference.kind === 'card')
    return { cardId: reference.cardId, printingId: null, copyId: null };
  const printingId =
    reference.kind === 'printing'
      ? reference.printingId
      : (copies.get(reference.copyId)?.printingId ?? null);
  return {
    cardId:
      printingId === null
        ? null
        : (printings.find((item) => item.printingId === printingId)?.cardId ?? null),
    printingId,
    copyId: reference.kind === 'copy' ? reference.copyId : null,
  };
}

function sameHierarchy(
  left: UserCardsReference,
  right: UserCardsReference,
  copies: ReadonlyMap<string, PhysicalCopy>,
): boolean {
  const one = hierarchy(left, copies);
  const two = hierarchy(right, copies);
  return (
    one.cardId !== null &&
    one.cardId === two.cardId &&
    (left.kind === 'card' ||
      right.kind === 'card' ||
      (one.printingId !== null &&
        one.printingId === two.printingId &&
        (left.kind === 'printing' || right.kind === 'printing' || one.copyId === two.copyId)))
  );
}

function associationMatches(
  target: UserCardsReference,
  association: Association,
  copies: ReadonlyMap<string, PhysicalCopy>,
): boolean {
  const reference: UserCardsReference =
    association.targetLevel === 'card'
      ? { kind: 'card', cardId: association.targetId }
      : association.targetLevel === 'printing'
        ? { kind: 'printing', printingId: association.targetId }
        : { kind: 'copy', copyId: association.targetId };
  return sameHierarchy(target, reference, copies);
}

function associationContributes(
  target: UserCardsReference,
  association: Association,
  copies: ReadonlyMap<string, PhysicalCopy>,
): boolean {
  // Aggregation broadens identity; unlike tag criteria, it cannot narrow an association.
  if (association.targetLevel === 'card' && target.kind !== 'card') return false;
  if (association.targetLevel === 'printing' && target.kind === 'copy') return false;
  return associationMatches(target, association, copies);
}

function copiesFor(
  target: UserCardsReference,
  copies: ReadonlyMap<string, PhysicalCopy>,
): PhysicalCopy[] {
  return [...copies.values()].filter((copy) =>
    sameHierarchy(target, { kind: 'copy', copyId: copy.copyId }, copies),
  );
}

function intendedQuantity(associations: readonly Association[]): number | null {
  return associations.reduce<number | null>(
    (sum, item) => (item.quantity === null ? sum : (sum ?? 0) + item.quantity),
    null,
  );
}

function fragments(
  references: readonly UserCardsReference[],
  copies: ReadonlyMap<string, PhysicalCopy>,
  associations: readonly Association[],
  tags: readonly Tag[],
  privateRevision: number,
  tagId: string | undefined,
): UserCardsFragmentsResult {
  const result = new Map<
    string,
    UserCardsFragmentsResult['fragments'] extends ReadonlyMap<string, infer Value> ? Value : never
  >();
  for (const reference of references) {
    const key = referenceKey(reference);
    const related = associations.filter((item) => associationContributes(reference, item, copies));
    result.set(key, {
      reference,
      ownedCopyCount: copiesFor(reference, copies).length,
      tagIds: [...new Set(related.map((item) => item.tagId))],
      physicalLocationCount: new Set(
        related
          .filter((item) => tags.find((tag) => tag.tagId === item.tagId)?.kind === 'location')
          .map((item) => item.tagId),
      ).size,
      intendedQuantity:
        tagId === undefined
          ? null
          : (intendedQuantity(related.filter((item) => item.tagId === tagId)) ?? 0),
    });
  }
  return { privateRevision: String(privateRevision), fragments: result, missing: [] };
}

function ensureSession(
  sessions: ImportSession[],
  sessionId: string,
  sourceKind: string,
  sourceId: string,
  sourceReference: string | null,
): ImportSession {
  const existing = sessions.find((session) => session.sessionId === sessionId);
  if (existing !== undefined) return existing;
  const session: ImportSession = {
    sessionId,
    sourceKind,
    sourceId,
    sourceReference,
    state: 'pending',
    pendingEntries: 0,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 1,
  };
  sessions.push(session);
  return session;
}

function refreshSession(session: ImportSession, entries: readonly ImportEntry[]): ImportSession {
  const own = entries.filter((entry) => entry.sessionId === session.sessionId);
  const pendingEntries = own.filter((entry) => entry.state === 'pending').length;
  const confirmedEntries = own.filter((entry) => entry.state === 'confirmed').length;
  const discardedEntries = own.filter((entry) => entry.state === 'discarded').length;
  return {
    ...session,
    state:
      pendingEntries > 0 || own.length === 0
        ? 'pending'
        : confirmedEntries > 0
          ? 'confirmed'
          : 'discarded',
    pendingEntries,
    confirmedEntries,
    discardedEntries,
    revision: Math.max(session.revision, ...own.map((entry) => entry.revision)),
  };
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
