/**
 * Retained-state reading shared by the pages and editors of the UserInterface
 * (docs/ui/architecture.md#state-ownership-and-restoration).
 *
 * A history entry keeps the representation its owner captured; the reader interprets only the
 * outer shape an owner of that representation supplies, and it never restricts the values the
 * owner bounded itself.
 */

import type { CardListRetained } from '../../card-list/index.js';

/** One retained state as a record of values, or null when it carries none. */
export function readState(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The CardList state one retained owner kept, or undefined when this visit restored none. */
export function readRetainedList<Context>(
  value: Readonly<Record<string, unknown>> | null,
): CardListRetained<Context> | undefined {
  const list = value?.list;
  return typeof list === 'object' && list !== null && !Array.isArray(list)
    ? (list as CardListRetained<Context>)
    : undefined;
}
