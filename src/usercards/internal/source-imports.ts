/**
 * Source imports (docs/user-cards.md#source-imports, docs/user-cards.md#persistence-and-recovery).
 *
 * A pasted card list, a public Moxfield deck and a reviewed Wizards preconstructed list are parsed
 * inside this boundary into pending entries of the account. Parsing never changes physical
 * ownership: a parsed line becomes a reviewable pending entry, and only an explicit confirmation
 * creates copies. Every entry keeps what its source published — name, section, edition, collector
 * number, language, finish and declared quantity — so an unresolved name or printing stays
 * reviewable, and it keeps a durable identity inside its acquisition source, so a repeated import
 * recognizes the lines it already staged or acquired instead of adding them twice.
 *
 * Reconciliation compares each parsed line with what the source recorded: a line whose declared
 * quantity is already covered by its pending and confirmed entries stages nothing, an increased
 * quantity stages only the uncovered difference for review, and a removed or reduced line changes
 * nothing. Source identity, the official reference of a reviewed list and the line's published
 * description are stored with the session and entries, never derived from editable labels or from
 * the physical copies a confirmation later creates. One acquisition source owns one import
 * session, so its recorded pending entries, acquisitions and the successive quantities of one line
 * stay addressable together however often the source is imported.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { finishes, type Catalog, type Finish, type PrintingRecord } from '../../catalog/index.js';
import { physicalFinishAvailability, resolveAvailablePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import type { UserCardsSqlTransactor } from './executor.js';
import { stagedLineFingerprint } from './fingerprint.js';
import { createPostgresImportStore } from './imports.js';
import {
  USERCARDS_LIMITS,
  type ImportEntryId,
  type ImportSession,
  type ImportSessionId,
  type ImportSourceLine,
  type TrustedUserContext,
} from './model.js';
import { createMoxfieldDeckSource, type MoxfieldDeckSource } from './moxfield.js';
import type { ImportStore, NewStagedImportEntry, SourceLineEntry } from './store.js';

/** A pasted card list: text lines of `quantity name (SET) number` (docs/user-cards.md#source-imports). */
export interface PastedCardListImport {
  readonly format: 'pasted-list';
  /** Identity of the pasted list inside the account; a repeated import of it reuses the identity. */
  readonly sourceId: string;
  readonly text: string;
}

/** A public Moxfield deck the component reads through the configured deck source. */
export interface MoxfieldDeckImport {
  readonly format: 'moxfield';
  /** Public Moxfield deck link, for example `https://moxfield.com/decks/<identity>`. */
  readonly url: string;
}

/** One line of a reviewed Wizards preconstructed deck list, as the owner reviewed it. */
export interface ReviewedWizardsLine {
  readonly name: string;
  readonly quantity: number;
  readonly section?: string | null;
  readonly set?: string | null;
  readonly collectorNumber?: string | null;
  readonly language?: string | null;
  readonly finish?: Finish | null;
}

/**
 * A reviewed Wizards preconstructed deck list. The owner reviewed the official product list; the
 * component keeps its official reference and never discovers or scrapes preconstructed products.
 */
export interface WizardsPreconImport {
  readonly format: 'wizards-precon';
  /**
   * Namespaced identity of the reviewed product list, for example
   * `wizards:mkm:deadly-disguise:regular:en`.
   */
  readonly sourceId: string;
  /** Official Wizards decklist the owner reviewed. */
  readonly reference: string;
  readonly entries: readonly ReviewedWizardsLine[];
}

export type StageSourceImportInput =
  PastedCardListImport | MoxfieldDeckImport | WizardsPreconImport;

/**
 * What one parsed row became: a new pending entry (`staged`), a line whose quantity its pending
 * entries already cover (`pending`), a line the source already acquired (`acquired`), or a row the
 * import could not read (`invalid`).
 */
export type SourceImportOutcome = 'staged' | 'pending' | 'acquired' | 'invalid';

/** One parsed source row and the reconciliation outcome of its line. */
export interface SourceImportRow {
  /** One-based position of the row in its source, so a row error is addressable. */
  readonly position: number;
  /** What the source published for this row; null when the row itself could not be read. */
  readonly line: ImportSourceLine | null;
  readonly outcome: SourceImportOutcome;
  /** Why this row staged nothing, or the reason its pending entry needs the owner's review. */
  readonly problem: string | null;
  /** Pending or recorded entry this row is represented by; null when the row is unreadable. */
  readonly entryId: ImportEntryId | null;
  readonly sessionId: ImportSessionId | null;
}

export interface SourceImportResult {
  readonly privateRevision: string;
  /** The import session the rows belong to, prepared even when this call staged nothing. */
  readonly session: ImportSession;
  /** Every parsed row in source order, including the rows that produced no entry. */
  readonly rows: readonly SourceImportRow[];
  /** Rows this call staged as new pending entries. */
  readonly staged: number;
}

/** The source-import operations of the UserCards contract. */
export interface SourceImportOperations {
  /**
   * Parses one supported source into the account's pending entries and reconciles every parsed line
   * with what the source already staged and acquired. Unresolved lines are staged for review,
   * unreadable rows are reported without failing the readable ones, and no call changes ownership.
   */
  stageSourceImport(
    context: TrustedUserContext,
    input: StageSourceImportInput,
  ): Promise<SourceImportResult>;
}

export interface SourceImportDependencies {
  /**
   * Transaction-capable SQL executor supplied by Application. Statements use `:name` placeholders
   * and read or write the component's own storage.
   */
  readonly sql: UserCardsSqlTransactor;
  /** Catalog contract used to validate the printings a source publishes. */
  readonly catalog: Catalog;
  /**
   * Moxfield deck source; defaults to the component's own public-API access. A deployment can
   * replace it with configured limits or an approved access path.
   */
  readonly decks?: MoxfieldDeckSource;
}

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;
const identifierSchema = z.string().min(1).max(identifierLength);

const stageSourceImportRequestSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('pasted-list'),
    sourceId: identifierSchema,
    text: z.string().min(1).max(USERCARDS_LIMITS.maxSourceTextLength),
  }),
  z.object({
    format: z.literal('moxfield'),
    url: identifierSchema,
  }),
  z.object({
    format: z.literal('wizards-precon'),
    sourceId: identifierSchema,
    reference: z.string().min(1).max(USERCARDS_LIMITS.maxSourceReferenceLength),
    entries: z.array(z.unknown()).min(1).max(USERCARDS_LIMITS.maxSourceLines),
  }),
]);

type StageSourceImportRequest = z.infer<typeof stageSourceImportRequestSchema>;

/**
 * One parsed source line, before the catalog and the recorded state are consulted. `content` is the
 * line's identity inside its source without its quantity, so a quantity change is the same line
 * while a line that now names another printing is a different one.
 */
interface ParsedSourceLine {
  readonly kind: 'line';
  /** One-based position of the row in its source. */
  readonly position: number;
  readonly name: string | null;
  readonly section: string | null;
  readonly set: string | null;
  readonly collectorNumber: string | null;
  readonly language: string | null;
  readonly finish: Finish | null;
  readonly quantity: number;
  /** Printing reference the source published; null when it named none. */
  readonly printingId: string | null;
  readonly content: string;
}

/** One source row that could not be read into a card line. */
interface UnreadableSourceRow {
  readonly kind: 'unreadable';
  readonly position: number;
  readonly problem: string;
}

type ParsedSourceRow = ParsedSourceLine | UnreadableSourceRow;

/** One parsed line with the catalog's answer for its published printing reference. */
interface ResolvedSourceLine {
  readonly printingId: string | null;
  readonly finish: Finish | null;
  /** Why the line needs the owner's review, or null when it resolved without one. */
  readonly problem: string | null;
}

/** Canonical card name of a line a source published without a printing reference. */
function canonicalName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s*\/+\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Identity of one line inside its source, without its quantity: a changed quantity is the same
 * line, while a line that now names another printing or edition is a different one.
 */
function lineContent(line: {
  readonly name: string | null;
  readonly set: string | null;
  readonly collectorNumber: string | null;
  readonly finish: Finish | null;
  readonly printingId: string | null;
}): string {
  const finish = line.finish ?? '';
  return line.printingId === null
    ? [
        'named',
        canonicalName(line.name ?? ''),
        (line.set ?? '').toLowerCase(),
        (line.collectorNumber ?? '').toLowerCase(),
        finish,
      ].join('\u0000')
    : ['printing', line.printingId, finish].join('\u0000');
}

/** Durable identity of one parsed line inside its acquisition source. */
function sourceLineKey(content: string, occurrence: number): string {
  return createHash('sha256').update(`${content}\u0000${occurrence}`, 'utf8').digest('hex');
}

/**
 * The import session of one acquisition source. One source owns one session, so its pending
 * entries, its recorded acquisitions and the successive quantities of one line stay together
 * however often the source is imported, and a confirmation can distinguish an additional quantity
 * of a line from the quantity it already acquired.
 */
function sourceImportSession(sourceKind: string, sourceId: string): string {
  return createHash('sha256')
    .update(`source-import\u0000${sourceKind}\u0000${sourceId}`, 'utf8')
    .digest('hex');
}

/**
 * Identity of the next pending entry of one source line. `attempt` counts the entries the line
 * already recorded, so a line whose entry was discarded stages a fresh entry instead of replaying
 * the discarded one, while an identical re-import of a pending line stages nothing at all.
 */
function sourceEntryId(sessionId: string, key: string, attempt: number): string {
  return createHash('sha256')
    .update(`${sessionId}\u0000${key}\u0000${attempt}`, 'utf8')
    .digest('hex');
}

const pastedLineProblem = 'Use “quantity card name”, optionally followed by “(SET) number”.';
const pastedSectionHeader =
  /^(commander|deck|mainboard|sideboard|considering|maybeboard|tokens)\s*:?\s*(?:\(\d+\))?$/i;
const pastedLinePattern =
  /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9]+)\)\s+([\w★-]+))?(?:\s+\*(F|E)\*)?$/i;

/**
 * Parses a pasted card list. Blank lines, comments and section headers are not card lines; a line
 * that does not read as `quantity name (SET) number` is an explicit unreadable row, and the readable
 * lines keep their position in the pasted text.
 */
function parsePastedList(text: string): readonly ParsedSourceRow[] {
  const rows: ParsedSourceRow[] = [];
  let section: string | null = null;
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const position = index + 1;
    const row = raw.trim();
    if (row === '' || row.startsWith('//') || row.startsWith('#')) {
      continue;
    }
    const header = row.match(pastedSectionHeader);
    if (header !== null) {
      section = (header[1] ?? '').toLowerCase();
      continue;
    }
    const match = row.match(pastedLinePattern);
    const quantity = match === null ? 0 : Number(match[1] ?? '');
    if (
      match === null ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > USERCARDS_LIMITS.maxCreateQuantity
    ) {
      rows.push({ kind: 'unreadable', position, problem: pastedLineProblem });
      continue;
    }
    const name = (match[2] ?? '').trim();
    const set = match[3] ?? null;
    const collectorNumber = match[4] ?? null;
    const marker = match[5]?.toUpperCase();
    const finish: Finish | null = marker === 'F' ? 'foil' : marker === 'E' ? 'etched' : null;
    if (
      name === '' ||
      name.length > identifierLength ||
      (set?.length ?? 0) > identifierLength ||
      (collectorNumber?.length ?? 0) > identifierLength
    ) {
      rows.push({
        kind: 'unreadable',
        position,
        problem: 'The line names a card with an unreadable name, edition or number.',
      });
      continue;
    }
    rows.push({
      kind: 'line',
      position,
      name,
      section,
      set,
      collectorNumber,
      language: null,
      finish,
      quantity,
      printingId: null,
      content: lineContent({ name, set, collectorNumber, finish, printingId: null }),
    });
  }
  return rows;
}

const moxfieldCardSchema = z.object({
  name: z.string().min(1).max(identifierLength),
  scryfall_id: z.string().min(1).max(identifierLength).optional(),
  set: z.string().max(identifierLength).optional(),
  cn: z.string().max(identifierLength).optional(),
  collector_number: z.string().max(identifierLength).optional(),
  lang: z.string().max(identifierLength).optional(),
});

const moxfieldLineSchema = z.object({
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity),
  finish: z.string().max(identifierLength).optional(),
  isFoil: z.boolean().optional(),
  card: moxfieldCardSchema,
});

const moxfieldBoardSchema = z.object({
  cards: z.record(z.string(), z.unknown()).optional(),
});

const moxfieldDeckSchema = z.object({
  isPrivate: z.boolean().optional(),
  isPasswordProtected: z.boolean().optional(),
  boards: z.record(z.string(), z.unknown()).optional(),
  mainboard: z.unknown().optional(),
  commanders: z.unknown().optional(),
  companions: z.unknown().optional(),
  sideboard: z.unknown().optional(),
  maybeboard: z.unknown().optional(),
  tokens: z.unknown().optional(),
});

type MoxfieldDeck = z.infer<typeof moxfieldDeckSchema>;

/**
 * Boards a deck contributes to ownership. Sideboards, maybeboards, considering and tokens describe
 * cards the owner has not declared as acquired, so the import never stages them.
 */
const moxfieldSections = ['mainboard', 'commanders', 'companions'] as const;
const moxfieldBoardKeys = [
  'mainboard',
  'commanders',
  'companions',
  'sideboard',
  'maybeboard',
  'tokens',
] as const;

/** The lines of every included board, in provider order. */
function moxfieldBoards(deck: MoxfieldDeck): readonly (readonly [string, readonly unknown[]])[] {
  const boards = new Map<string, readonly unknown[]>();
  for (const [section, board] of Object.entries(deck.boards ?? {})) {
    const parsed = moxfieldBoardSchema.safeParse(board);
    if (parsed.success) {
      boards.set(section, Object.values(parsed.data.cards ?? {}));
    }
  }
  for (const section of moxfieldBoardKeys) {
    if (boards.has(section)) {
      continue;
    }
    const parsed = moxfieldBoardSchema.safeParse(deck[section]);
    if (parsed.success) {
      boards.set(section, Object.values(parsed.data.cards ?? {}));
    }
  }
  return moxfieldSections.flatMap((section) => {
    const cards = boards.get(section);
    return cards === undefined ? [] : [[section, cards] as const];
  });
}

/** Parses one Moxfield deck document; an unreadable line is an explicit row, not a failed import. */
function parseMoxfieldDeck(document: unknown): readonly ParsedSourceRow[] {
  const deck = moxfieldDeckSchema.safeParse(document);
  if (!deck.success) {
    throw new UserCardsError('unavailable', 'Moxfield returned a deck this import cannot read.');
  }
  if (deck.data.isPrivate === true || deck.data.isPasswordProtected === true) {
    throw new UserCardsError('invalid-request', 'Only public Moxfield decks can be imported.');
  }
  const rows: ParsedSourceRow[] = [];
  for (const [section, cards] of moxfieldBoards(deck.data)) {
    for (const value of cards) {
      const position = rows.length + 1;
      const line = moxfieldLineSchema.safeParse(value);
      if (!line.success) {
        rows.push({
          kind: 'unreadable',
          position,
          problem: 'Moxfield returned a line this import cannot read.',
        });
        continue;
      }
      const { card } = line.data;
      const set = card.set ?? null;
      const collectorNumber = card.cn ?? card.collector_number ?? null;
      const language = card.lang ?? null;
      const printingId = card.scryfall_id ?? null;
      const finish: Finish =
        line.data.finish === 'etched'
          ? 'etched'
          : line.data.finish === 'foil' || line.data.isFoil === true
            ? 'foil'
            : 'nonfoil';
      rows.push({
        kind: 'line',
        position,
        name: card.name,
        section,
        set,
        collectorNumber,
        language,
        finish,
        quantity: line.data.quantity,
        printingId,
        content: lineContent({ name: card.name, set, collectorNumber, finish, printingId }),
      });
    }
  }
  return rows;
}

const wizardsLineSchema = z.object({
  name: z.string().min(1).max(identifierLength),
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity),
  section: z.string().min(1).max(identifierLength).nullable().optional(),
  set: z.string().min(1).max(identifierLength).nullable().optional(),
  collectorNumber: z.string().min(1).max(identifierLength).nullable().optional(),
  language: z.string().min(1).max(identifierLength).nullable().optional(),
  finish: z.enum(finishes).nullable().optional(),
});

/** Parses the lines of a reviewed Wizards list; an unreadable line is an explicit row. */
function parseReviewedWizardsLines(entries: readonly unknown[]): readonly ParsedSourceRow[] {
  return entries.map((value, index) => {
    const position = index + 1;
    const parsed = wizardsLineSchema.safeParse(value);
    if (!parsed.success) {
      return {
        kind: 'unreadable',
        position,
        problem:
          'A reviewed list line needs a card name, a quantity from 1 to ' +
          `${USERCARDS_LIMITS.maxCreateQuantity} and readable attributes.`,
      };
    }
    const { name, quantity } = parsed.data;
    const set = parsed.data.set ?? null;
    const collectorNumber = parsed.data.collectorNumber ?? null;
    const finish = parsed.data.finish ?? null;
    return {
      kind: 'line',
      position,
      name,
      section: parsed.data.section ?? null,
      set,
      collectorNumber,
      language: parsed.data.language ?? null,
      finish,
      quantity,
      printingId: null,
      content: lineContent({ name, set, collectorNumber, finish, printingId: null }),
    };
  });
}

const moxfieldDeckPath = /^\/decks\/([A-Za-z0-9_-]{16,80})\/?$/;

/** The public deck identity and canonical link of one pasted Moxfield deck URL. */
function moxfieldDeck(urlText: string): { readonly sourceId: string; readonly reference: string } {
  let url: URL | undefined;
  try {
    url = new URL(urlText);
  } catch {
    /* The validation error below covers every unreadable link. */
  }
  const match = url === undefined ? null : url.pathname.match(moxfieldDeckPath);
  if (
    url === undefined ||
    url.protocol !== 'https:' ||
    (url.hostname !== 'moxfield.com' && url.hostname !== 'www.moxfield.com') ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    match === null
  ) {
    throw new UserCardsError(
      'invalid-request',
      'Enter a public HTTPS Moxfield deck link, without extra parameters.',
    );
  }
  const sourceId = match[1] ?? '';
  return { sourceId, reference: `https://moxfield.com/decks/${sourceId}` };
}

const wizardsSourcePattern = /^wizards:[a-z0-9-]{2,16}:[a-z0-9-]{1,60}:[a-z0-9-]{1,24}:[a-z]{2}$/;

/** Validates the namespaced identity of one reviewed Wizards product list. */
function wizardsSource(sourceId: string): void {
  if (!wizardsSourcePattern.test(sourceId)) {
    throw new UserCardsError(
      'invalid-request',
      'A reviewed Wizards list needs a namespaced source identity such as ' +
        'wizards:<edition>:<product>:<variant>:<language>.',
    );
  }
}

/** Validates the official Wizards decklist link a reviewed list is kept with. */
function wizardsReference(reference: string): void {
  let url: URL | undefined;
  try {
    url = new URL(reference);
  } catch {
    /* The validation error below covers every unreadable link. */
  }
  if (
    url === undefined ||
    url.protocol !== 'https:' ||
    url.hostname !== 'magic.wizards.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    !/^\/[a-z]{2}\/news\/[a-z0-9/-]+$/.test(url.pathname)
  ) {
    throw new UserCardsError(
      'invalid-request',
      'Keep the official decklist link on magic.wizards.com; the import never scrapes a product.',
    );
  }
}

/**
 * One parsed source with the session, identity and reference it is stored under. The session is
 * derived from the source identity, so every import of one source reconciles with the same records.
 */
interface ReadSource {
  readonly sessionId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceReference: string | null;
  readonly rows: readonly ParsedSourceRow[];
}

/**
 * A parsed source stays inside the line bound and keeps at least one readable card line; a whole
 * row set of errors is an unsupported format rather than an import of nothing.
 */
function requireParsedSource(rows: readonly ParsedSourceRow[]): void {
  if (rows.length > USERCARDS_LIMITS.maxSourceLines) {
    throw new UserCardsError(
      'invalid-request',
      `One source import parses at most ${USERCARDS_LIMITS.maxSourceLines} lines.`,
    );
  }
  if (rows.every((row) => row.kind === 'unreadable')) {
    throw new UserCardsError(
      'invalid-request',
      'The source listed no card lines this import can parse.',
    );
  }
}

/** Invalid source-import input, with the bound the caller exceeded. */
function invalidSourceImportMessage(): string {
  return (
    'A source import needs one of the formats pasted-list, moxfield or wizards-precon, its ' +
    `source identity and at most ${USERCARDS_LIMITS.maxSourceLines} lines.`
  );
}

/**
 * The source-import operations of the UserCards contract (docs/user-cards.md#source-imports). Every
 * operation is scoped by the trusted account it receives and never reads or writes another
 * account's record.
 */
export function createSourceImports(
  dependencies: SourceImportDependencies,
): SourceImportOperations {
  const sql: UserCardsSqlTransactor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') {
    throw new TypeError('createSourceImports requires a transaction-capable SQL executor.');
  }
  const catalog: Catalog | undefined = dependencies?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('createSourceImports requires the Catalog contract to resolve printings.');
  }
  const deckSource: MoxfieldDeckSource | undefined = dependencies?.decks;
  if (deckSource !== undefined && typeof deckSource.readDeck !== 'function') {
    throw new TypeError('createSourceImports requires a Moxfield deck source.');
  }
  const decks: MoxfieldDeckSource = deckSource ?? createMoxfieldDeckSource();
  const store: ImportStore = createPostgresImportStore(sql);

  /** Parses one request's source into rows, keeping its identity and official reference. */
  async function readSource(request: StageSourceImportRequest): Promise<ReadSource> {
    switch (request.format) {
      case 'pasted-list': {
        const rows = parsePastedList(request.text);
        requireParsedSource(rows);
        return {
          sessionId: sourceImportSession('pasted-list', request.sourceId),
          sourceKind: 'pasted-list',
          sourceId: request.sourceId,
          sourceReference: null,
          rows,
        };
      }
      case 'moxfield': {
        const deck = moxfieldDeck(request.url);
        let document: unknown;
        try {
          document = await decks.readDeck(deck.sourceId);
        } catch (cause) {
          throw new UserCardsError(
            'unavailable',
            'The Moxfield deck could not be read; no import changed.',
            { cause },
          );
        }
        const rows = parseMoxfieldDeck(document);
        requireParsedSource(rows);
        return {
          sessionId: sourceImportSession('moxfield', deck.sourceId),
          sourceKind: 'moxfield',
          sourceId: deck.sourceId,
          sourceReference: deck.reference,
          rows,
        };
      }
      case 'wizards-precon': {
        wizardsSource(request.sourceId);
        wizardsReference(request.reference);
        const rows = parseReviewedWizardsLines(request.entries);
        requireParsedSource(rows);
        return {
          sessionId: sourceImportSession('wizards-precon', request.sourceId),
          sourceKind: 'wizards-precon',
          sourceId: request.sourceId,
          sourceReference: request.reference,
          rows,
        };
      }
    }
  }

  return {
    async stageSourceImport(context, input): Promise<SourceImportResult> {
      const accountId = accountIdFrom(context);
      const request = stageSourceImportRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError('invalid-request', invalidSourceImportMessage());
      }
      const source = await readSource(request.data);

      // A printed reference the catalog cannot resolve keeps its line reviewable; the whole import
      // is never turned into a failure by one line's reference.
      const printings = await resolveAvailablePrintings(
        catalog,
        source.rows.flatMap((row) =>
          row.kind === 'line' && row.printingId !== null ? [row.printingId] : [],
        ),
      );

      // Durable identity of each parsed line: duplicates of one content get their own occurrence.
      const keys = new Map<ParsedSourceLine, string>();
      const occurrences = new Map<string, number>();
      for (const row of source.rows) {
        if (row.kind === 'unreadable') {
          continue;
        }
        const occurrence = (occurrences.get(row.content) ?? 0) + 1;
        occurrences.set(row.content, occurrence);
        keys.set(row, sourceLineKey(row.content, occurrence));
      }

      const recorded = await store.readSourceLines(accountId, source.sourceKind, source.sourceId, [
        ...keys.values(),
      ]);
      const recordedByKey = new Map(recorded.map((record) => [record.sourceLineKey, record]));

      const rows: SourceImportRow[] = [];
      const fresh: NewStagedImportEntry[] = [];
      for (const row of source.rows) {
        if (row.kind === 'unreadable') {
          rows.push({
            position: row.position,
            line: null,
            outcome: 'invalid',
            problem: row.problem,
            entryId: null,
            sessionId: null,
          });
          continue;
        }
        const key = keys.get(row) ?? '';
        const record = recordedByKey.get(key) ?? null;
        const resolved = resolveLine(row, printings);
        const line: ImportSourceLine = {
          name: row.name,
          section: row.section,
          set: row.set,
          collectorNumber: row.collectorNumber,
          language: row.language,
          finish: row.finish,
          declaredQuantity: row.quantity,
          problem: resolved.problem,
        };
        const held = (record?.pendingQuantity ?? 0) + (record?.confirmedQuantity ?? 0);
        if (held >= row.quantity) {
          const entry: SourceLineEntry | null =
            record?.pendingEntry ?? record?.confirmedEntry ?? null;
          rows.push({
            position: row.position,
            line,
            outcome: (record?.pendingQuantity ?? 0) > 0 ? 'pending' : 'acquired',
            problem: resolved.problem,
            entryId: entry?.entryId ?? null,
            sessionId: entry?.sessionId ?? null,
          });
          continue;
        }
        // The line's uncovered quantity becomes one pending entry; a line that grew stages only
        // the difference, and a source whose line was removed or reduced stages nothing at all.
        const entry: NewStagedImportEntry = {
          entryId: sourceEntryId(source.sessionId, key, (record?.records ?? 0) + 1),
          printingId: resolved.printingId,
          finish: resolved.finish,
          condition: null,
          quantity: row.quantity - held,
          candidates: [],
          sourceLine: line,
          sourceLineKey: key,
          fingerprint: stagedLineFingerprint({
            printingId: resolved.printingId,
            finish: resolved.finish,
            condition: null,
            quantity: row.quantity - held,
            candidates: [],
          }),
        };
        fresh.push(entry);
        rows.push({
          position: row.position,
          line,
          outcome: 'staged',
          problem: resolved.problem,
          entryId: entry.entryId,
          sessionId: source.sessionId,
        });
      }

      const outcome = await store.stageEntries(accountId, {
        sessionId: source.sessionId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        sourceReference: source.sourceReference,
        entries: fresh,
      });
      if (outcome.outcome === 'line-conflict') {
        throw new UserCardsError(
          'conflict',
          'The source changed while it was being imported; reload it before importing it again.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        rows,
        staged: fresh.length,
      };
    },
  };
}

/** The catalog's answer for one parsed line's published printing reference. */
function resolveLine(
  row: ParsedSourceLine,
  printings: ReadonlyMap<string, PrintingRecord>,
): ResolvedSourceLine {
  if (row.printingId === null) {
    return {
      printingId: null,
      finish: null,
      problem: 'The source named no printing; choose one during review.',
    };
  }
  const printing = printings.get(row.printingId);
  if (printing === undefined) {
    return {
      printingId: null,
      finish: null,
      problem: 'The catalog does not publish this printing; choose one during review.',
    };
  }
  const availability = physicalFinishAvailability(printing, row.finish);
  return availability.outcome === 'unavailable'
    ? { printingId: null, finish: null, problem: availability.problem }
    : { printingId: row.printingId, finish: availability.finish, problem: null };
}
