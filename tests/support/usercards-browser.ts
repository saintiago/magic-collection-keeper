/**
 * UserCards browser fixtures (docs/user-cards.md#browser-operation-lifecycle): a private client
 * whose operations a case scripts, the provider-owned operation facade over it, and an in-memory
 * attempt storage. Component and integration cases build their access through these, so the
 * lifecycle they assert is the one the UserInterface presents.
 */

import {
  createUserCardsOperations,
  type UserCardsAccountOperations,
  type UserCardsAttemptStorage,
  type UserCardsBrowserClient,
  type UserCardsBrowserOperation,
} from '../../src/usercards/browser.js';

/** One private client whose operations the case scripts; unscripted calls fail loudly. */
export function unusedUserCardsClient(): UserCardsBrowserClient {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
  return {
    readCopies: unused,
    correctCopy: unused,
    listTags: unused,
    readTags: unused,
    createTag: unused,
    renameTag: unused,
    listAssociations: unused,
    readAssociations: unused,
    createAssociation: unused,
    changeAssociation: unused,
    removeAssociation: unused,
    setCopyLocation: unused,
    listImportSessions: unused,
    listImportEntries: unused,
    stageImportEntries: unused,
    stageSourceImport: unused,
    stageCaptureObservation: unused,
    reviewImportEntry: unused,
    attachImportCandidates: unused,
    discardImportEntry: unused,
    discardImportSession: unused,
    confirmImport: unused,
    recoverImportOperation: unused,
  };
}

/** One in-memory attempt storage a case can reuse across facade constructions. */
export function memoryAttemptStorage(): UserCardsAttemptStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** The account-scoped UserCards operations over one scripted private client. */
export function userCardsAccount(options: {
  readonly client?: Partial<UserCardsBrowserClient>;
  readonly storage?: UserCardsAttemptStorage | null;
  readonly operations?: readonly UserCardsBrowserOperation[];
  readonly accountId?: string;
}): UserCardsAccountOperations {
  return createUserCardsOperations({
    client: { ...unusedUserCardsClient(), ...options.client },
    storage: options.storage ?? null,
    ...(options.operations === undefined ? {} : { operations: options.operations }),
  }).account(options.accountId ?? 'alice');
}
