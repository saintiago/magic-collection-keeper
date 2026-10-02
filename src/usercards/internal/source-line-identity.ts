/**
 * Durable identity of one parsed source line inside its import
 * (docs/user-cards.md#source-imports). Ordinary source reconciliation and the migration loader
 * both derive it from what the source published — the named card tuple, or the printing it
 * published — without the declared quantity, so a repeated, re-staged or migrated line is
 * recognized by its source content rather than by the reviewed values it later carries
 * (docs/migration.md#rehearsal-and-execution-gates).
 */

import { createHash } from 'node:crypto';

import type { Finish } from '../../catalog/contract.js';

/** What one parsed source line published, beside its quantity and review state. */
export interface PublishedSourceLine {
  readonly name: string | null;
  readonly set: string | null;
  readonly collectorNumber: string | null;
  readonly language: string | null;
  /** Finish the source declared; null when it declared none. */
  readonly finish: Finish | null;
  /** Printing reference the source published; null when it named none. */
  readonly printingId: string | null;
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
 * line, while a line that now names another printing, edition or language is a different one.
 */
export function sourceLineContent(line: PublishedSourceLine): string {
  const finish = line.finish ?? '';
  return line.printingId === null
    ? [
        'named',
        canonicalName(line.name ?? ''),
        (line.set ?? '').toLowerCase(),
        (line.collectorNumber ?? '').toLowerCase(),
        (line.language ?? '').toLowerCase(),
        finish,
      ].join('\u0000')
    : ['printing', line.printingId, finish].join('\u0000');
}

/**
 * Durable identity of one parsed line inside its import. Equivalent rows of one import share it, so
 * which row currently carries a quantity never decides whether that quantity is already covered
 * (docs/user-cards.md#source-imports).
 */
export function sourceLineKey(line: PublishedSourceLine): string {
  return createHash('sha256').update(sourceLineContent(line), 'utf8').digest('hex');
}
