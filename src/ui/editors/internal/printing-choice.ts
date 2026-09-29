import type { CardListToolSelection } from '../../../card-list/index.js';

export const printingChoiceGuidance = 'Select exactly one printing, then choose it.';

/** A correction or refinement names one exact printing, never the first of several choices. */
export function singlePrintingChoice(selection: CardListToolSelection) {
  const target = selection.targets[0];
  return selection.targets.length === 1 && target?.kind === 'printing' ? target : null;
}
