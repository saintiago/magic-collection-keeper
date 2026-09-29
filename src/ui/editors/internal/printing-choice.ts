import type { CardListToolSelection } from '../../../card-list/index.js';

export const printingChoiceGuidance = 'Select exactly one printing, then choose it.';

/** A correction or refinement names one exact printing, never the first of several choices. */
export function singlePrintingChoice(selection: CardListToolSelection) {
  const target = selection.targets[0];
  return selection.targets.length === 1 && target?.kind === 'printing' ? target : null;
}

export const cardChoiceGuidance = 'Select exactly one card, then choose it.';

/**
 * A card-level review names one playable identity, never the first of several choices. A
 * card-level association needs no printing, so the deck destination stays reachable for a list
 * that only names cards.
 */
export function singleCardChoice(selection: CardListToolSelection) {
  const target = selection.targets[0];
  return selection.targets.length === 1 && target?.kind === 'card' ? target : null;
}
