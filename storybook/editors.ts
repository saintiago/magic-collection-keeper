/** Keep private prerequisites inside the editor action's single visible pending stage. */
import { createCopyAccess, createEditors, type CardViews, type Editors } from '../src/ui/index.js';
import type { UserCardsAccountOperations } from '../src/usercards/browser.js';
import type { ManualProgression } from './progression.js';

export function createLocalEditors(
  cardViews: CardViews,
  copies: UserCardsAccountOperations,
  progression: ManualProgression,
): Editors {
  const editors = createEditors({ cardViews });
  return {
    ...editors,
    copyBulk(options) {
      const access = createCopyAccess(copies);
      let completion: Promise<void> | null = null;
      const editor = editors.copyBulk({
        ...options,
        access: {
          ...access,
          async read(ids, signal) {
            completion ??= progression.wait('Applying copy changes', () => undefined, signal);
            await completion;
            return access.read(ids, signal);
          },
        },
      });
      return {
        ...editor,
        apply(intent) {
          completion = null;
          editor.apply(intent);
        },
      };
    },
    tagView(options) {
      return editors.tagView({
        ...options,
        access: { ...options.access, readCopies: copies.readCopies },
      });
    },
  };
}
