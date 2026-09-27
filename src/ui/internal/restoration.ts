/**
 * Bounded, account-isolated presentation state the UserInterface keeps for history entries
 * (docs/user-interface.md#pages-and-navigation).
 *
 * A history entry carries an opaque token instead of view content: the shell opens the token when
 * it presents the entry and saves the page's own query and selection state beside the scroll offset
 * and the focused element when the user leaves, so returning through history reads that entry's own
 * state back and no view content is serialized into the URL or the history entry. Each snapshot
 * belongs to one account: a snapshot is never restored for another account, and the store is
 * cleared when the presented account changes. A token names the lifetime of the store that opened
 * it, so a history entry that survives a reload never reads another store's snapshot.
 */

import { UI_LIMITS } from './limits.js';

/** One bounded value a page keeps for restoration. */
export type UiRestorationValue = string | number | boolean | readonly string[] | null;

/** Bounded query and selection state one page keeps for restoration. */
export type UiRestorationState = Readonly<Record<string, UiRestorationValue>>;

/** What the shell restores when history returns to a view. */
export interface UiViewSnapshot {
  /** Page-supplied state, or null when the page keeps none or supplied an unbounded value. */
  readonly state: UiRestorationState | null;
  /** Document scroll offset at the moment the view was left. */
  readonly scrollY: number;
  /** Id of the element focused when the view was left, or null. */
  readonly focusId: string | null;
  /** Visible element and its viewport offset, retained across later asynchronous layout. */
  readonly anchorId?: string | null;
  readonly anchorTop?: number;
}

/** The bounded presentation state the shell keeps for the history entries of one account. */
export interface UiViewStateStore {
  /** Opens the token one presented history entry carries; the entry keeps no state until saved. */
  open(): string;
  /** Whether a token belongs to this store's lifetime; another lifetime's tokens never restore. */
  owns(token: string): boolean;
  /** Keeps one view's state under the token of the history entry the user is leaving. */
  save(accountId: string, token: string, snapshot: UiViewSnapshot): void;
  /** State one history entry keeps for the account, or null when it kept none. */
  read(accountId: string, token: string): UiViewSnapshot | null;
  /** Removes every snapshot; the presented account changed or the session ended. */
  clear(): void;
  /** Snapshots currently kept. */
  readonly size: number;
}

/** Prefix of the opaque per-entry tokens the shell puts in a history entry. */
const UI_VIEW_TOKEN_PREFIX = 'ui-view-';

let storeSerial = 0;

/**
 * One alphanumeric lifetime id, distinct for every store the page creates. The delimiter keeps a
 * token of one lifetime from ever reading as a token of another, so history that survives a reload
 * shares no token with the new store.
 */
function storeLifetime(): string {
  storeSerial += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${stamp}${storeSerial.toString(36)}${noise}`;
}

/**
 * One store per UserInterface. It keeps at most `limit` snapshots, oldest first, and drops the
 * oldest beyond that bound; a token that is no longer kept simply restores nothing.
 */
export function createViewStateStore(limit: number = UI_LIMITS.viewStates): UiViewStateStore {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('The view state store requires a positive, finite entry limit.');
  }
  const prefix = `${UI_VIEW_TOKEN_PREFIX}${storeLifetime()}-`;
  const snapshots = new Map<
    string,
    { readonly accountId: string; readonly view: UiViewSnapshot }
  >();
  let sequence = 0;
  const owns = (token: string): boolean =>
    typeof token === 'string' && token.startsWith(prefix) && token.length > prefix.length;
  return {
    open() {
      sequence += 1;
      // Tokens stay opaque and unique inside this store; they never carry view content.
      return `${prefix}${sequence}`;
    },
    owns,
    save(accountId, token, snapshot) {
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new TypeError('A view snapshot belongs to one verified account.');
      }
      // A token of another store lifetime cannot name the entry that was left, so it keeps nothing.
      if (!owns(token)) {
        return;
      }
      const view = readSnapshot(snapshot);
      snapshots.delete(token);
      while (snapshots.size >= limit) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        snapshots.delete(oldest);
      }
      snapshots.set(token, { accountId, view });
    },
    read(accountId, token) {
      const kept = snapshots.get(token);
      return kept !== undefined && kept.accountId === accountId ? kept.view : null;
    },
    clear() {
      snapshots.clear();
    },
    get size() {
      return snapshots.size;
    },
  };
}

/** Reads one snapshot, dropping state outside the declared bounds instead of corrupting it. */
function readSnapshot(snapshot: UiViewSnapshot): UiViewSnapshot {
  return {
    state: readState(snapshot?.state),
    scrollY: readScroll(snapshot?.scrollY),
    focusId: readFocusId(snapshot?.focusId),
    ...(snapshot.anchorId == null
      ? {}
      : {
          anchorId: readFocusId(snapshot.anchorId),
          anchorTop:
            typeof snapshot.anchorTop === 'number' && Number.isFinite(snapshot.anchorTop)
              ? snapshot.anchorTop
              : 0,
        }),
  };
}

function readState(value: unknown): UiRestorationState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > UI_LIMITS.restorationKeys) {
    return null;
  }
  const state: Record<string, UiRestorationValue> = {};
  for (const [key, entry] of entries) {
    const bounded = readValue(entry);
    if (bounded === undefined) {
      return null;
    }
    state[key] = bounded;
  }
  return state;
}

function readValue(value: unknown): UiRestorationValue | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return value.length <= UI_LIMITS.restorationValueText ? value : undefined;
  }
  if (
    Array.isArray(value) &&
    value.length <= UI_LIMITS.restorationList &&
    value.every((entry) => typeof entry === 'string' && entry.length <= UI_LIMITS.restorationText)
  ) {
    return value.map(String);
  }
  return undefined;
}

function readScroll(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readFocusId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
