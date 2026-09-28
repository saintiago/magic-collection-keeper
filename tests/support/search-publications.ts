/**
 * Publication fixtures for Search indexing cases (docs/testing.md#search). Search is tested
 * against supplied implementations of the provider-owned publication contracts, so a case
 * controls exactly what a source published — a repeated change page, a moved snapshot revision,
 * an expired position — without a database or another component. Each provider's own contract
 * tests cover its real behavior; the integration cases exercise Search over the real publications.
 */

import {
  CatalogError,
  type CatalogChange,
  type CatalogPublication,
  type CatalogPublishedRecord,
  type CatalogRevision,
  type CatalogSnapshotPage,
  type CatalogSnapshotRequest,
} from '../../src/catalog/index.js';
import {
  UserCardsError,
  type UserCardsChange,
  type UserCardsPublication,
  type UserCardsPublishedRecord,
  type UserCardsSnapshotPage,
  type UserCardsSnapshotRequest,
} from '../../src/usercards/index.js';

export interface CatalogChangePage {
  readonly changes: readonly CatalogChange[];
  readonly position: string;
}

export interface CatalogPublicationFixtureOptions {
  readonly revision: CatalogRevision;
  readonly position: string;
  readonly records?: readonly CatalogPublishedRecord[];
  /** Changes published after the snapshot position, in position order. */
  readonly changes?: readonly CatalogChange[];
  /** Dropped history: a resume before this position fails like an expired one. */
  readonly expiredBelow?: string;
  /** Deliver the first change page a second time, as a repeated delivery does. */
  readonly repeatFirstChangePage?: boolean;
  /**
   * Publish a replacement snapshot right after the first page was handed out, as a catalog that
   * synchronized another revision while a consumer was paging does. The continuation the first
   * page carries is then obsolete.
   */
  readonly replaceSnapshotAfterFirstPage?: {
    readonly revision: CatalogRevision;
    readonly position: string;
    readonly records: readonly CatalogPublishedRecord[];
  };
}

/** A scripted Catalog publication whose snapshot a case can replace while a run reads it. */
export interface CatalogPublicationFixture {
  readonly publication: CatalogPublication;
  /** Positions the fixture was asked to resume from, in order. */
  readonly reads: readonly string[];
  /** Publishes further changes after the fixture was created. */
  publish(...changes: readonly CatalogChange[]): void;
  /** Publishes a replacement snapshot with another revision, position and records. */
  replaceSnapshot(snapshot: {
    readonly revision: CatalogRevision;
    readonly position: string;
    readonly records: readonly CatalogPublishedRecord[];
  }): void;
  /** Drops the retained history before a position, as publication retention does. */
  dropHistoryBefore(position: string): void;
}

export function createCatalogPublicationFixture(
  options: CatalogPublicationFixtureOptions,
): CatalogPublicationFixture {
  let revision = options.revision;
  let position = options.position;
  let records = [...(options.records ?? [])];
  let changes = [...(options.changes ?? [])];
  let expiredBelow = options.expiredBelow ?? null;
  let repeatedPage: readonly CatalogChange[] | null = null;
  let firstPageDelivered = false;
  let pendingReplacement = options.replaceSnapshotAfterFirstPage ?? null;
  const reads: string[] = [];

  function snapshotToken(): string {
    return `${revision.revisionId}@${position}`;
  }

  const publication: CatalogPublication = {
    async readSnapshot(request: CatalogSnapshotRequest = {}): Promise<CatalogSnapshotPage> {
      const continued = request.continuation === undefined ? null : decode(request.continuation);
      if (continued !== null && continued.token !== snapshotToken()) {
        throw new CatalogError(
          'stale-continuation',
          'The catalog published another revision after this page was read.',
        );
      }
      const pageSize = request.pageSize ?? 500;
      const offset = continued?.offset ?? 0;
      const page = records.slice(offset, offset + pageSize);
      const next = offset + page.length;
      const result: CatalogSnapshotPage = {
        revision,
        position,
        records: page,
        continuation:
          next < records.length ? encode({ token: snapshotToken(), offset: next }) : null,
      };
      if (continued === null && pendingReplacement !== null) {
        revision = pendingReplacement.revision;
        position = pendingReplacement.position;
        records = [...pendingReplacement.records];
        pendingReplacement = null;
      }
      return result;
    },

    async readChanges(request: {
      readonly position: string;
      readonly pageSize?: number;
    }): Promise<CatalogChangePage> {
      reads.push(request.position);
      if (expiredBelow !== null && compare(request.position, expiredBelow) < 0) {
        throw new CatalogError(
          'stale-continuation',
          'This position is not part of the retained catalog publication history.',
        );
      }
      if (repeatedPage !== null) {
        const page = repeatedPage;
        repeatedPage = null;
        return { changes: page, position: lastPosition(page, request.position) };
      }
      const anchors = [position, ...changes.map((change) => change.position)];
      if (!anchors.includes(request.position)) {
        throw new CatalogError(
          'stale-continuation',
          'This position is not part of the retained catalog publication history.',
        );
      }
      const start = anchors.indexOf(request.position);
      const page = changes.slice(start, start + (request.pageSize ?? 500));
      if (options.repeatFirstChangePage && !firstPageDelivered && page.length > 0) {
        firstPageDelivered = true;
        repeatedPage = page;
      }
      return { changes: page, position: lastPosition(page, request.position) };
    },
  };

  return {
    publication,
    reads,
    publish(...next: readonly CatalogChange[]): void {
      changes = [...changes, ...next];
    },
    replaceSnapshot(snapshot): void {
      revision = snapshot.revision;
      position = snapshot.position;
      records = [...snapshot.records];
      // A snapshot read at a position already includes every change published up to it.
      changes = changes.filter((change) => compare(change.position, position) > 0);
    },
    dropHistoryBefore(next): void {
      expiredBelow = next;
    },
  };
}

export interface UserCardsChangePage {
  readonly accountId: string;
  readonly changes: readonly UserCardsChange[];
  readonly position: string;
}

export interface UserCardsPublicationFixtureOptions {
  readonly accountId: string;
  /** Position the account's snapshot was read at; "0" means it published nothing yet. */
  readonly position: string;
  readonly records?: readonly UserCardsPublishedRecord[];
  /** Changes published after the snapshot position, in position order. */
  readonly changes?: readonly UserCardsChange[];
  /** Dropped history: a resume before this position fails like an expired one. */
  readonly expiredBelow?: string;
}

export interface UserCardsPublicationFixture {
  readonly publication: UserCardsPublication;
  /** Positions the fixture was asked to resume from, in order. */
  readonly reads: readonly string[];
  publish(...changes: readonly UserCardsChange[]): void;
  /** Replaces the account's snapshot with another position and record set. */
  replaceSnapshot(snapshot: {
    readonly position: string;
    readonly records: readonly UserCardsPublishedRecord[];
  }): void;
  /** Drops the retained history before a position, as publication retention does. */
  dropHistoryBefore(position: string): void;
}

export function createUserCardsPublicationFixture(
  options: UserCardsPublicationFixtureOptions,
): UserCardsPublicationFixture {
  const accountId = options.accountId;
  let position = options.position;
  let records = [...(options.records ?? [])];
  let changes = [...(options.changes ?? [])];
  let expiredBelow = options.expiredBelow ?? null;
  const reads: string[] = [];
  const token = (): string => `${accountId}@${position}`;

  const publication: UserCardsPublication = {
    async readSnapshot(request: UserCardsSnapshotRequest): Promise<UserCardsSnapshotPage> {
      assertAccount(request.accountId);
      const continued = request.continuation === undefined ? null : decode(request.continuation);
      if (continued !== null && continued.token !== token()) {
        throw new UserCardsError(
          'stale-continuation',
          'The account published another revision after this page was read.',
        );
      }
      const pageSize = request.pageSize ?? 500;
      const offset = continued?.offset ?? 0;
      const page = records.slice(offset, offset + pageSize);
      const next = offset + page.length;
      return {
        accountId,
        position,
        records: page,
        continuation: next < records.length ? encode({ token: token(), offset: next }) : null,
      };
    },

    async readChanges(request: {
      readonly accountId: string;
      readonly position: string;
      readonly pageSize?: number;
    }): Promise<UserCardsChangePage> {
      assertAccount(request.accountId);
      reads.push(request.position);
      if (expiredBelow !== null && compare(request.position, expiredBelow) < 0) {
        throw new UserCardsError(
          'stale-continuation',
          'This position is not part of the retained private publication history.',
        );
      }
      const anchors = [position, ...changes.map((change) => change.position)];
      if (!anchors.includes(request.position)) {
        throw new UserCardsError(
          'stale-continuation',
          'This position is not part of this account’s publication history.',
        );
      }
      const start = anchors.indexOf(request.position);
      const page = changes.slice(start, start + (request.pageSize ?? 500));
      return { accountId, changes: page, position: lastPosition(page, request.position) };
    },
  };

  function assertAccount(requested: string): void {
    if (requested !== accountId) {
      throw new UserCardsError(
        'not-found',
        'These publication fixtures belong to another account.',
      );
    }
  }

  return {
    publication,
    reads,
    publish(...next: readonly UserCardsChange[]): void {
      changes = [...changes, ...next];
    },
    replaceSnapshot(snapshot): void {
      position = snapshot.position;
      records = [...snapshot.records];
      // A snapshot read at a position already includes every change published up to it.
      changes = changes.filter((change) => compare(change.position, position) > 0);
    },
    dropHistoryBefore(next): void {
      expiredBelow = next;
    },
  };
}

function lastPosition(changes: readonly { readonly position: string }[], fallback: string): string {
  return changes.at(-1)?.position ?? fallback;
}

/** Compares two decimal positions the fixtures use to decide expiry; real providers stay opaque. */
function compare(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

interface Continuation {
  readonly token: string;
  readonly offset: number;
}

function encode(payload: Continuation): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(continuation: string): Continuation {
  return JSON.parse(Buffer.from(continuation, 'base64url').toString('utf8')) as Continuation;
}
