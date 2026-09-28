/**
 * Private operations a browser journey never invokes. A journey replaces the boundary Application
 * supplies; the pages it presents use their own part of the contract, so the operations they do
 * not present reject visibly instead of reporting an empty success.
 */

import {
  createUserCardsOperations,
  type UserCardsAttemptStorage,
  type UserCardsBrowserClient,
  type UserCardsOperations,
} from '../../src/usercards/browser.js';

function unused(): Promise<never> {
  return Promise.reject(new Error('This journey invokes no such private UserCards operation.'));
}

const unusedClient: UserCardsBrowserClient = {
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

/**
 * The UserCards browser operations of a journey that invokes none of them: the provider-owned
 * facade over the rejecting client, so the presented capabilities keep their real shape.
 */
export const unusedUserCards: UserCardsOperations = createUserCardsOperations({
  client: unusedClient,
  storage: browserAttemptStorage(),
});

/** The rejecting private client itself, for a harness that scripts some of its operations. */
export const unusedUserCardsClient: UserCardsBrowserClient = unusedClient;

/**
 * The browsing session's attempt storage, as Application supplies it: unfinished operations
 * survive a reload of the page without outliving the browser session that began them.
 */
export function browserAttemptStorage(): UserCardsAttemptStorage | null {
  try {
    return typeof globalThis.sessionStorage === 'object' && globalThis.sessionStorage !== null
      ? globalThis.sessionStorage
      : null;
  } catch {
    return null;
  }
}
