/** Offline legacy interpretation. Source: 128c903, application/tagged-collection.js and domain/deck-import.js. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const legacyRevision = '128c903ff109868acc854f0ff239c8c0f925d803';
const id = z.string().min(1).max(200);
const quantity = z.number().int().min(1);
export const finish = z.enum(['nonfoil', 'foil', 'etched']);
export const condition = z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'UNK']);
export const allocation = z.object({ tag_id: id, quantity }).passthrough();
export const assignment = z
  .object({
    locations: z.array(allocation).default([]),
    tag_ids: z.array(id).default([]),
    locations_override: z.boolean().default(false),
    source_ids: z.array(id).default([]),
  })
  .passthrough();
const card = z.object({ id, lang: id }).passthrough();
const inventory = z
  .object({
    id: z.union([id, z.number().int().nonnegative()]),
    printing_id: id,
    language: id,
    condition,
    finish,
    quantity,
  })
  .passthrough();
export const document = z
  .object({
    space: id,
    id,
    version: z.number().int().positive(),
    value: z.record(z.string(), z.unknown()),
  })
  .strict();
export const tag = z
  .object({
    id,
    label: z.string().min(1).max(200),
    type: z.enum(['location', 'role', 'category']),
    kind: id,
  })
  .passthrough();
const lot = z
  .object({
    line_id: id,
    printing_id: id,
    finish,
    condition: condition.optional(),
    owned_quantity: quantity,
    allocated_quantity: z.number().int().min(0),
    locations: z.array(allocation).optional(),
    tag_ids: z.array(id).default([]),
  })
  .passthrough();
const deck = z
  .object({
    source_id: id,
    provider: id,
    tag_id: id.optional(),
    lots: z.array(lot),
    review: z.object({ additive_default: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();
export const account = z
  .object({
    owner: id,
    accountId: id,
    inventory: z.array(inventory),
    documents: z.array(document),
    operations: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
export const bundle = z
  .object({
    format: z.literal('keeper-legacy-export-v1'),
    legacyRevision: z.literal(legacyRevision),
    snapshotId: id,
    accounts: z.array(account),
    catalog: z.array(
      z
        .object({
          printingId: id,
          cardId: id,
          language: id,
          finishes: z.array(finish).min(1),
          paper: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type LegacyAccount = z.infer<typeof account>;
export type LegacyBundle = z.infer<typeof bundle>;
type Assignment = z.infer<typeof assignment>;
export interface LegacyGroup {
  id: string;
  printingId: string;
  language: string;
  finish: z.infer<typeof finish>;
  condition: z.infer<typeof condition>;
  quantity: number;
  locations: Assignment['locations'];
  tagIds: string[];
  sources: string[];
}
interface Component {
  id: string;
  printingId: string;
  language: string;
  finish: z.infer<typeof finish>;
  condition: z.infer<typeof condition>;
  quantity: number;
  locations: Assignment['locations'];
  tagIds: string[];
  source: string | null;
  additive: boolean;
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Canonical JSON permits identical exports to be compared despite object property order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Export contains a non-JSON value.');
  return result;
}
export function stableId(...parts: string[]): string {
  return 'legacy-' + digest(JSON.stringify(parts));
}
export function records(input: LegacyAccount, space: string) {
  return input.documents.filter((d) => d.space === space);
}
/** Reproduce effective ownership, including retained source lots and manual total overrides. */
export function projectLegacy(input: LegacyAccount): LegacyGroup[] {
  const components: Component[] = input.inventory.map((r) => ({
    id: String(r.id),
    printingId: r.printing_id,
    language: r.language,
    finish: r.finish,
    condition: r.condition,
    quantity: r.quantity,
    locations: [],
    tagIds: [],
    source: null,
    additive: false,
  }));
  const cards = new Map(
    records(input, 'cards').map((d) => {
      const c = card.parse(d.value);
      if (c.id !== d.id) throw new Error('Stored printing identity differs from its document key.');
      return [d.id, c];
    }),
  );
  const seenSource = new Set<string>();
  for (const d of records(input, 'decks')) {
    const source = deck.parse(d.value);
    if (source.source_id !== d.id || seenSource.has(source.source_id))
      throw new Error('Duplicate or mismatched source identity.');
    seenSource.add(source.source_id);
    const seenLines = new Set<string>();
    for (const l of source.lots) {
      if (seenLines.has(l.line_id) || l.allocated_quantity > l.owned_quantity)
        throw new Error('Invalid source lot quantities or duplicate line identity.');
      seenLines.add(l.line_id);
      const c = cards.get(l.printing_id);
      if (c === undefined) throw new Error('A durable imported printing is missing.');
      const base = {
        printingId: l.printing_id,
        language: c.lang,
        finish: l.finish,
        condition: l.condition ?? ('UNK' as const),
        tagIds: l.tag_ids,
        source: source.source_id,
        additive: source.review?.additive_default === true,
      };
      if (l.allocated_quantity > 0) {
        if (l.locations === undefined && source.tag_id === undefined)
          throw new Error('Source lot has no location definition.');
        components.push({
          ...base,
          id: `source:${source.source_id}:${l.line_id}`,
          quantity: l.allocated_quantity,
          locations: l.locations ?? [{ tag_id: source.tag_id!, quantity: l.allocated_quantity }],
        });
      }
      if (l.owned_quantity > l.allocated_quantity)
        components.push({
          ...base,
          id: `retained:${source.source_id}:${l.line_id}`,
          quantity: l.owned_quantity - l.allocated_quantity,
          locations: [],
        });
    }
  }
  const groups = new Map<string, Component[]>();
  for (const c of components) {
    const key = [c.printingId, c.language, c.finish, c.condition].join('|');
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const assignments = new Map(
    records(input, 'assignments').map((d) => [d.id, assignment.parse(d.value)]),
  );
  const totals = new Map(
    records(input, 'totals').map((d) => [
      d.id,
      z.object({ delta: z.number().int().safe() }).parse(d.value).delta,
    ]),
  );
  const result: LegacyGroup[] = [];
  const used = new Set<string>();
  for (const [key, members] of groups) {
    const first = members[0]!;
    const sourceManaged = members.some((c) => c.source !== null);
    const groupId = sourceManaged ? `group:${digest(key)}` : first.id;
    used.add(groupId);
    const a = assignments.get(groupId);
    const uncovered = a?.locations_override
      ? members.filter((c) => c.additive && c.source !== null && !a.source_ids.includes(c.source))
      : [];
    const locations = new Map<string, number>();
    for (const l of a?.locations_override
      ? [...a.locations, ...uncovered.flatMap((c) => c.locations)]
      : members.flatMap((c) => c.locations)) {
      locations.set(l.tag_id, (locations.get(l.tag_id) ?? 0) + l.quantity);
    }
    const count = members.reduce((n, c) => n + c.quantity, 0) + (totals.get(groupId) ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid effective ownership quantity.');
    result.push({
      id: groupId,
      printingId: first.printingId,
      language: first.language,
      finish: first.finish,
      condition: first.condition,
      quantity: count,
      locations: [...locations].map(([tag_id, quantity]) => ({ tag_id, quantity })),
      tagIds: [
        ...new Set(
          a
            ? [...a.tag_ids, ...uncovered.flatMap((c) => c.tagIds)]
            : members.flatMap((c) => c.tagIds),
        ),
      ].sort(),
      sources: [...new Set(members.flatMap((c) => (c.source === null ? [] : [c.source])))].sort(),
    });
  }
  for (const key of [...assignments.keys(), ...totals.keys()]) {
    if (!used.has(key))
      throw new Error('An assignment or total override references no effective inventory group.');
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
