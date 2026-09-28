/**
 * CardViews public entry point (docs/ui/card-views.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * CardViews renders cards, lists, details and pickers and translates direct input into explicit
 * intents. It receives a CardList public factory and a list description, creates one list
 * instance per mounted view and reports the visible viewport, the selection and the user's
 * open-target and action intents back through that instance's contract. This module owns the DOM,
 * its measurements, accessibility, and the application of scroll and focus instructions; it owns
 * no selection rules, membership, pagination, enrichment, caching, operation execution or
 * outcome presentation. An action the user chooses is reported with the list's explicit target
 * context; the consumer that supplied the action runs it and presents what its provider
 * established.
 *
 * Pages and Editors receive this module through UI composition and depend on this entry point
 * only; the module's internals stay private to the UI component (docs/architecture.md).
 */

export {
  cardListBasicContent,
  createCardListView,
  type UiCardList,
  type UiCardListFactory,
  type UiCardListOptions,
  type UiCardListPresentation,
  type UiEntryImage,
  type UiEntryOwnership,
  type UiEntryTag,
} from './internal/list.js';
export type { UiActionIntent, UiListAction } from '../shared/actions.js';
export {
  createCardViews,
  type CardViews,
  type CardViewDetail,
  type CardViewDetailOptions,
  type CardViewEntryPresentation,
  type CardViewOpenOptions,
  type CardViewPickerChoice,
  type CardViewPickerOptions,
} from './internal/views.js';
