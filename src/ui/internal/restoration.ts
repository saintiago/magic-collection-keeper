/**
 * Bounded, account-isolated presentation state the UserInterface keeps for history entries
 * (docs/user-interface.md#pages-and-navigation).
 *
 * Navigating away captures the page's own query and selection state beside the scroll offset and
 * the focused element, and puts an opaque token in that history entry. Returning through history
 * reads the token back, so no view content is serialized into the URL or the history entry. Each
 * snapshot belongs to one account: a snapshot is never restored for another account, and the store
 * is cleared when the presented account changes.
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
}

/** The bounded presentation state the shell keeps for the history entries of one account. */
export interface UiViewStateStore {
  /** Keeps one view's state and returns the token to place in that history entry. */
  save(accountId: string, snapshot: UiViewSnapshot): string;
  /** State one history entry keeps for the account, or null when it kept none. */
  read(accountId: string, token: string): UiViewSnapshot | null;
  /** Removes every snapshot; the presented account changed or the session ended. */
  clear(): void;
  /** Snapshots currently kept. */
  readonly size: number;
}

/**
 * One store per UserInterface. It keeps at most `limit` snapshots, oldest first, and drops the
 * oldest beyond that bound; a token that is no longer kept simply restores nothing.
 */
export function createViewStateStore(limit: number = UI_LIMITS.viewStates): UiViewStateStore {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('The view state store requires a positive, finite entry limit.');
  }
  const snapshots = new Map<
    string,
    { readonly accountId: string; readonly view: UiViewSnapshot }
  >();
  let sequence = 0;
  return {
    save(accountId, snapshot) {
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new TypeError('A view snapshot belongs to one verified account.');
      }
      const view = readSnapshot(snapshot);
      // Tokens stay opaque and unique inside this store; they never carry view content.
      const token = `ui-view-${++sequence}`;
      while (snapshots.size >= limit) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        snapshots.delete(oldest);
      }
      snapshots.set(token, { accountId, view });
      return token;
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
    return value.length <= UI_LIMITS.restorationText ? value : undefined;
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
