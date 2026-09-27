/**
 * Private operations a browser journey never invokes. A journey replaces the boundary Application
 * supplies; the pages it presents use their own part of the contract, so the operations they do
 * not present reject visibly instead of reporting an empty success.
 */

import type { UserCardsClient } from '../../src/application/index.js';

function unused(): Promise<never> {
  return Promise.reject(new Error('This journey invokes no such private UserCards operation.'));
}

export const unusedUserCards: UserCardsClient = {
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
