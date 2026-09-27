/**
 * Account-isolated state the UserInterface keeps for a bounded number of history entries
 * (docs/user-interface.md#state-ownership-and-restoration).
 *
 * A history entry carries an opaque token instead of view content: the shell opens the token when
 * it presents the entry and saves the page's own retained state beside the scroll offset, the
 * focused element and the visible anchor the shell owns, so returning through history reads that
 * entry's own state back and no view content is serialized into the URL or the history entry.
 *
 * The store keeps the state a page captures as it is: navigation owns the lifetime and eviction of
 * history entries, never the page's representation. It does not interpret or restrict card
 * identities, selection arrays, list cursors, loading progress or any other page state, so a
 * history bound never becomes a card-selection limit and whole states are never dropped because one
 * value is unusual. Each owner bounds the resources it retains itself.
 *
 * Each snapshot belongs to one account: a snapshot is never restored for another account, and the
 * store is cleared when the presented account changes. A token names the lifetime of the store
 * that opened it, so a history entry that survives a reload never reads another store's snapshot.
 */

import { UI_LIMITS } from './limits.js';

/** What the shell restores when history returns to a view. */
export interface UiViewSnapshot {
  /**
   * State the page retained for this history entry, or null when it kept none. The shell keeps the
   * reference and hands it back to the same page without inspecting or restricting it; the page
   * owns its shape and bounds.
   */
  readonly state: unknown;
  /** Document scroll offset at the moment the view was left. */
  readonly scrollY: number;
  /** Id of the element focused when the view was left, or null. */
  readonly focusId: string | null;
  /** Visible element and its viewport offset, retained across later asynchronous layout. */
  readonly anchorId?: string | null;
  readonly anchorTop?: number;
}

/** The opaque state the shell keeps for the history entries of one account. */
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
  /** Snapshots currently kept; eviction beyond the bound releases the oldest one. */
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
 * oldest beyond that bound; a token that is no longer kept simply restores nothing. Dropping the
 * entry releases the state the owner retained for it.
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

/**
 * Reads one snapshot, keeping the page's own state untouched and sanitizing only the presentation
 * state the shell owns: an unreadable scroll offset, focus or anchor never corrupts restoration.
 */
function readSnapshot(snapshot: UiViewSnapshot): UiViewSnapshot {
  return {
    state: snapshot?.state ?? null,
    scrollY: readScroll(snapshot?.scrollY),
    focusId: readFocusId(snapshot?.focusId),
    ...(snapshot?.anchorId == null
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

function readScroll(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readFocusId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
