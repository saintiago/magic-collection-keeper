/**
 * Unfinished source imports of one account (docs/user-interface.md#source-imports,
 * docs/user-cards.md#import-state-and-identity, docs/user-cards.md#persistence-and-recovery).
 *
 * The Import page identifies every source request with the import it composes, so importing the
 * same source again reconciles the list that identity already started instead of staging a second
 * one. That identity cannot live only beside the rendered form: a request whose response is still
 * pending, a response that was lost and a reload of the page must keep the identity together with
 * the input it belongs to, and switching the source method away and back must not lose it either
 * (docs/user-interface.md#source-imports). This store keeps every dispatched request whose
 * outcome the provider has not established in the presented account's session storage: retrying
 * that input reuses the identity it was dispatched under, another input composes an import of its
 * own, and an established outcome, an explicitly discarded import or the end of the account
 * releases the record. A record belongs to one account, is never read for another, and is validated
 * when it is read back, so input this page did not write is ignored instead of presented.
 */

import type { StageSourceImportInput } from '../../usercards/index.js';

import { UI_LIMITS } from './limits.js';

/** One source method the Import page parses into review. */
export type UiSourceFormat = StageSourceImportInput['format'];

/** The unsaved source input of one method, before the page names the import it composes. */
export type UiSourceInput =
  | { readonly format: 'pasted-list'; readonly text: string }
  | { readonly format: 'moxfield'; readonly url: string }
  | {
      readonly format: 'wizards-precon';
      readonly identity: string;
      readonly reference: string;
      readonly lines: string;
    };

/** One dispatched source import whose outcome the provider has not established yet. */
export interface UiUnfinishedSourceImport {
  /** Identity of the import the input composes. */
  readonly importId: string;
  /** The input that identity belongs to. */
  readonly input: UiSourceInput;
}

/** The unfinished source imports one account keeps and the storage that preserves them. */
export interface UiSourceImportRecovery {
  /** The unfinished imports keyed by import identity, in the order the page recorded them. */
  readonly outstanding: ReadonlyMap<string, UiUnfinishedSourceImport>;
  /**
   * Identity of an unfinished request with this input, or null for a new import.
   */
  retained(input: UiSourceInput): string | null;
  /** Keeps one dispatched request until its outcome is established. */
  remember(importId: string, input: UiSourceInput): void;
  /** Releases one import whose outcome is established or which the owner explicitly abandoned. */
  forgetImport(importId: string): void;
  /** Releases every unfinished import of the account; its private state ends with the account. */
  release(): void;
}

/** Prefix of the session-storage entry one account's unfinished source imports live under. */
const storagePrefix = 'keeper.source-imports.';

/**
 * The unfinished source imports of one account, read from the session storage that survives a
 * reload of the page without outliving the browser session that dispatched them. Storage that
 * refuses a record, or that cannot be read, leaves the in-memory records intact, so a request is
 * still retried with its own identity while the page lives.
 */
export function createSourceImportRecovery(
  storage: Storage | null,
  accountId: string,
): UiSourceImportRecovery {
  const outstanding = readUnfinished(storage, accountId);
  const write = (): void => keepUnfinished(storage, accountId, outstanding);
  return {
    outstanding,
    retained(input) {
      for (const record of outstanding.values()) {
        if (sameSourceInput(record.input, input)) {
          return record.importId;
        }
      }
      return null;
    },
    remember(importId, input) {
      // Retrying moves only this import last; other unresolved requests remain recoverable.
      outstanding.delete(importId);
      outstanding.set(importId, { importId, input });
      write();
    },
    forgetImport(importId) {
      if (outstanding.delete(importId)) {
        write();
      }
    },
    release() {
      outstanding.clear();
      releaseSourceImports(storage, accountId);
    },
  };
}

/**
 * Releases the unfinished source imports one account keeps. The shell reports the account it leaves
 * to every page implementation, so this ends the account's records even when another page is the
 * one presented (docs/user-interface.md#state-ownership-and-restoration).
 */
export function releaseSourceImports(storage: Storage | null, accountId: string): void {
  try {
    storage?.removeItem(storageKey(accountId));
  } catch {
    // Storage the context refuses keeps nothing this page can release.
  }
}

/** Whether two source inputs describe the same request of one method. */
function sameSourceInput(left: UiSourceInput, right: UiSourceInput): boolean {
  switch (left.format) {
    case 'pasted-list':
      return right.format === 'pasted-list' && left.text === right.text;
    case 'moxfield':
      return right.format === 'moxfield' && left.url === right.url;
    case 'wizards-precon':
      return (
        right.format === 'wizards-precon' &&
        left.identity === right.identity &&
        left.reference === right.reference &&
        left.lines === right.lines
      );
  }
}

/** Key of one account's unfinished source imports. */
function storageKey(accountId: string): string {
  return `${storagePrefix}${accountId}`;
}

/** The unfinished source imports one account kept, in the order they were recorded. */
function readUnfinished(
  storage: Storage | null,
  accountId: string,
): Map<string, UiUnfinishedSourceImport> {
  const unfinished = new Map<string, UiUnfinishedSourceImport>();
  const raw = readStored(storage, storageKey(accountId));
  if (raw === null) {
    return unfinished;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unfinished;
  }
  const record = readObject(parsed);
  if (record === null) {
    return unfinished;
  }
  for (const value of Object.values(record)) {
    const unfinishedImport = readUnfinishedImport(value);
    if (unfinishedImport !== null) {
      unfinished.set(unfinishedImport.importId, unfinishedImport);
    }
  }
  return unfinished;
}

/** Keeps one account's unfinished source imports under its own storage entry. */
function keepUnfinished(
  storage: Storage | null,
  accountId: string,
  outstanding: ReadonlyMap<string, UiUnfinishedSourceImport>,
): void {
  if (storage === null) {
    return;
  }
  const record: Record<string, UiUnfinishedSourceImport> = {};
  for (const [importId, unfinished] of outstanding) {
    record[importId] = unfinished;
  }
  try {
    storage.setItem(storageKey(accountId), JSON.stringify(record));
  } catch {
    // Storage that refuses the record keeps the in-memory one only.
  }
}

/** One storage value, or null when the context refuses the read. */
function readStored(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** One stored unfinished import, or null when the value is not one this page recorded. */
function readUnfinishedImport(value: unknown): UiUnfinishedSourceImport | null {
  const record = readObject(value);
  const format = readObject(record?.input)?.format;
  if (format !== 'pasted-list' && format !== 'moxfield' && format !== 'wizards-precon') {
    return null;
  }
  if (record === null) {
    return null;
  }
  const importId = readText(record.importId, UI_LIMITS.routeSegment);
  const input = readSourceInput(format, record.input);
  return importId === null || input === null ? null : { importId, input };
}

/** The input one stored record carries, or null when it is not one this page recorded. */
function readSourceInput(format: UiSourceFormat, value: unknown): UiSourceInput | null {
  const record = readObject(value);
  if (record === null || record.format !== format) {
    return null;
  }
  switch (format) {
    case 'pasted-list': {
      const text = readText(record.text, UI_LIMITS.importSourceText);
      return text === null ? null : { format, text };
    }
    case 'moxfield': {
      const url = readText(record.url, UI_LIMITS.entryKey);
      return url === null ? null : { format, url };
    }
    case 'wizards-precon': {
      const identity = readText(record.identity, UI_LIMITS.entryKey);
      const reference = readText(record.reference, UI_LIMITS.entryKey);
      const lines = readText(record.lines, UI_LIMITS.importSourceText);
      return identity === null || reference === null || lines === null
        ? null
        : { format, identity, reference, lines };
    }
  }
}

/** One record a stored value may carry, or null when it is not a plain record. */
function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One non-empty bounded string a stored record carries, or null when it is not one. */
function readText(value: unknown, bound: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= bound ? value : null;
}
