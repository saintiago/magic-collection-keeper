/** Gate visible reads, keeping their dependent provider calls inside the same completion. */
import {
  createCardListBrowser,
  type CardListBrowser,
  type CardListBrowserOptions,
  type CardListFragmentReader,
  type CardListSource,
} from '../src/card-list/index.js';
import type { ManualProgression } from './progression.js';

export function createLocalCardList(
  providers: CardListBrowserOptions,
  progression: ManualProgression,
): CardListBrowser {
  const browser = createCardListBrowser(providers);
  function source<Context>(
    label: string,
    binding: CardListSource<Context>,
  ): CardListSource<Context> {
    return {
      ...binding,
      load: (request) => progression.wait(label, () => binding.load(request), request.signal),
    };
  }
  function fragment<Value>(
    label: string,
    binding: CardListFragmentReader<Value>,
    prefix: string,
  ): CardListFragmentReader<Value> {
    return {
      ...binding,
      read: (request) =>
        request.keys.some((key) => key.startsWith(prefix))
          ? progression.wait(label, () => binding.read(request), request.signal)
          : binding.read(request),
    };
  }
  return {
    ...browser,
    account(accountId) {
      const bindings = browser.account(accountId);
      return {
        ...bindings,
        detailTarget: (target) => source('Loading card details', bindings.detailTarget(target)),
        cardPrintings: (card) =>
          source('Loading published printings', bindings.cardPrintings(card)),
        printingImages: () =>
          fragment('Loading card images', bindings.printingImages(), 'printing:'),
        copyTools: (ids) => fragment('Loading copy tools', bindings.copyTools(ids), 'copy:'),
      };
    },
  };
}
