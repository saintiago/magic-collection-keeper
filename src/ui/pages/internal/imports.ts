/**
 * Import page of the UserInterface (docs/ui/pages.md#page-map, docs/ui/editors.md,
 * docs/ui/capture-controls.md).
 *
 * The page composes one activity around its route context: the manual entry editor, the source
 * import editor, the camera capture controls bound to one pending import and the pending review
 * and confirmation editor. It owns layout, the lifetime of its mounted children and the
 * coordination between them — a staged manual line or source import hands the review the session
 * to present, and a capture change reconciles it — and it keeps the drafts its children capture
 * for the history entry. Loading, parsing, import identity, replay, staging and confirmation stay
 * with the provider-owned operations and the editors that present them; the page neither stages a
 * line nor decides an outcome (docs/ui/architecture.md#modules-and-composition).
 */

import type {
  UiImportReviewEditor,
  UiManualImportEditor,
  UiManualImportDraft,
  UiSourceImportEditor,
} from '../../editors/index.js';
import { createImportAccess } from '../../editors/index.js';
import type { UiPageDefinition } from '../../navigation/index.js';
import { readPageState } from './page-support.js';

/** The Import page: manual entry and source import beside one import's pending review. */
export function createImportPages(): readonly UiPageDefinition[] {
  return [importPage()];
}

function importPage(): UiPageDefinition {
  return {
    page: 'import',
    mount(container, context) {
      const document = container.ownerDocument;
      const accountId = context.account.accountId;
      const operations = context.capabilities.userCards.account(accountId);
      const access = createImportAccess(operations);
      const constraints = operations.constraints;
      const restored = readPageState(context.restored?.state);
      const editorContext = {
        document,
        access,
        constraints,
        cardList: context.capabilities.cardList,
        cardViews: context.modules.cardViews,
        accountId,
        catalog: context.capabilities.catalog,
        notices: context.notices,
        signal: context.signal,
      };

      // The review is referenced by its siblings while it is being composed: a staged line or
      // source import presents its session, and a capture change reconciles it.
      let review: UiImportReviewEditor | null = null;
      const manual: UiManualImportEditor = context.modules.editors.importManual({
        ...editorContext,
        restored,
        onChanged: (unknownOutcome) => {
          void review?.reconcile(unknownOutcome);
        },
      });
      const source: UiSourceImportEditor = context.modules.editors.importSource({
        ...editorContext,
        restored,
        onStaged: (sessionId) => {
          void review?.presentSession(sessionId);
        },
        onChanged: () => {
          void review?.reconcile();
        },
      });
      review = context.modules.editors.importReview({
        ...editorContext,
        restored,
        dialogs: context.dialogs,
      });
      const reviewEditor: UiImportReviewEditor = review;
      // Hands-free camera capture feeds the same pending review as manual entry: the page binds one
      // Capture session to this account and one pending import and disposes it with the view,
      // releasing the camera and the Recognition session (docs/ui/capture-controls.md).
      const capture = context.modules.captureControls({
        document,
        capture: context.capabilities.capture,
        accountId,
        importId: context.capabilities.capture.createImportId(),
        device: context.device,
        notices: context.notices,
        signal: context.signal,
        reviewChanged: (change) => {
          void reviewEditor.reconcileCapture(change);
        },
      });

      container.append(...manual.nodes, ...source.nodes, capture.element, ...reviewEditor.nodes);

      return {
        capture: () => ({
          sessionId: reviewEditor.capture().sessionId,
          manual: captureManualDraft(manual),
          // The unsaved source input stays with the entry as well: returning to the view keeps the
          // edits to retry, while the account keeps the identity of an import whose outcome was
          // not reported (docs/ui/editors.md).
          source: source.capture(),
          review: reviewEditor.capture().review,
          // The reviewed revisions of the explicit selection stay with the entry, so a
          // confirmation still covers entries the loaded window no longer presents.
          selection: reviewEditor.capture().selection,
          results: captureResults(manual),
          pending: reviewEditor.capturePending(),
        }),
        presented: async () => {
          const outstanding = [manual.presentation(), reviewEditor.presentation()].filter(
            (restoration): restoration is Promise<void> => restoration !== null,
          );
          await Promise.all(outstanding);
        },
        dispose: () => {
          capture.dispose();
          manual.dispose();
          source.dispose();
          reviewEditor.dispose();
        },
      };
    },
  };
}

/** The manual draft one capture takes from its editor. */
function captureManualDraft(manual: UiManualImportEditor): UiManualImportDraft {
  return manual.capture().manual;
}

/** The manual result-list state one capture takes from its editor. */
function captureResults(manual: UiManualImportEditor): unknown {
  return manual.capture().results;
}
