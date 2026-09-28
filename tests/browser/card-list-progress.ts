/** These page fixtures contain no account-lifetime progress; Application tests exercise that wiring. */

import type { SearchIndexingProgress } from '../../src/search/browser.js';

export function idleProgress(accountId: string): SearchIndexingProgress {
  const status = () => ({ accountId, state: 'idle' as const, outstanding: [], revisions: null });
  return {
    status,
    subscribe: () => () => {},
    committed: () => {},
    recheck: () => {},
    dispose: () => {},
  };
}
