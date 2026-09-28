/**
 * Action intents shared by the presentation modules of the UserInterface
 * (docs/ui/architecture.md#modules-and-composition, docs/ui/card-views.md, docs/ui/editors.md).
 *
 * A list presents the advisory actions of its explicit selection and reports the user's intent
 * through its own contract: the intent carries the targets the list observed, and the consumer
 * that supplied the action owns what it does. CardViews renders the controls and reports intent
 * only; Editors owns execution, pending state and the presentation of the operation's outcome.
 */

import type { CardListToolSelection } from '../../card-list/index.js';

/** One advisory action a list presents for its explicit selection. */
export interface UiListAction {
  /** Stable id the entry's tool availability fragment reports. */
  readonly id: string;
  /** Label of the action's control. */
  readonly label: string;
}

/**
 * The user's action intent over the list's explicit selection. The intent carries the target
 * context the list observed — including entries its loaded window no longer presents — so the
 * consumer that supplied the action acts on the selection and never on visible rows.
 */
export interface UiActionIntent {
  /** Id of the action the user chose. */
  readonly id: string;
  /** Explicit selected targets of the list at the moment the user acted. */
  readonly selection: CardListToolSelection;
}
