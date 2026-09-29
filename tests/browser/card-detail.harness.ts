/** Focused CardViews evidence over a real CardList and controlled image fragments. */
import {
  createCardList,
  type CardListEntry,
  type CardListEntryImage,
  type CardListFragmentResult,
} from '../../src/card-list/index.js';
import { createCardViews } from '../../src/ui/index.js';

const entry: CardListEntry = {
  key: 'printing:bolt',
  target: { kind: 'printing', printingId: 'bolt' },
  basic: {
    card: { cardId: 'bolt', name: 'Lightning Bolt', matchedName: null },
    printing: { printingId: 'bolt', edition: 'LEA', collectorNumber: '161', language: 'en' },
  },
  quantity: null,
};

export function installDetailHarness() {
  let demands = 0;
  let compositions = 0;
  let reads = 0;
  let publish: (() => void) | undefined;
  let reload: (() => void) | undefined;
  let finish:
    ((value: readonly CardListFragmentResult<readonly CardListEntryImage[]>[]) => void) | undefined;
  const lifetime = new AbortController();
  const detail = createCardViews().detail({
    document,
    create(options) {
      const list = createCardList(options);
      publish = () => list.setSelected(entry.key, true);
      reload = () => list.reloadFragment(entry.key, 'images');
      return {
        ...list,
        demand(request) {
          demands += 1;
          list.demand(request);
        },
      };
    },
    source: {
      load: async () => ({ status: 'page', entries: [entry], continuation: null, current: true }),
    },
    context: 'bolt',
    accountId: 'alice',
    pageSize: 1,
    identity: 'printing',
    fragments: {
      images: {
        read() {
          reads += 1;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
    content() {
      compositions += 1;
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Composed draft');
      return [input];
    },
    signal: lifetime.signal,
  });
  document.body.append(...detail.nodes);
  return {
    state: () => ({ demands, compositions, reads }),
    publish: () => publish?.(),
    reload: () => reload?.(),
    finish(failed: boolean) {
      finish?.([
        failed
          ? { key: entry.key, status: 'failed', message: 'Image unavailable' }
          : {
              key: entry.key,
              status: 'ready',
              values: [{ src: 'https://images.test/bolt.jpg', alt: 'Lightning Bolt image' }],
            },
      ]);
    },
    dispose() {
      lifetime.abort();
      detail.dispose();
    },
  };
}
export type DetailControl = ReturnType<typeof installDetailHarness>;
