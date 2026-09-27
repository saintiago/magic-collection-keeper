/**
 * Brief dialogs for small auxiliary actions (docs/user-interface.md#pages-and-navigation).
 *
 * A dialog asks one question and reports the user's decision; closing the view it belongs to
 * cancels it. Only text the caller supplied is rendered, so external text stays safe.
 */

export interface UiDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/** Dialogs the shell provides to the page it presents. */
export interface UiDialogs {
  /** Asks one brief question; false when the user cancels or the view closes. */
  confirm(options: UiDialogOptions): Promise<boolean>;
}

export interface UiDialogHost extends UiDialogs {
  /** Cancels every open dialog; the presented view is closing. */
  closeAll(): void;
}

/** Creates the dialog host of one shell, rendering dialogs into `parent`. */
export function createDialogs(parent: Element): UiDialogHost {
  const document = parent.ownerDocument;
  const open = new Set<() => void>();
  return {
    confirm(options) {
      const dialog = document.createElement('dialog');
      const title = document.createElement('h2');
      title.textContent = options.title;
      const message = document.createElement('p');
      message.textContent = options.message;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = options.cancelLabel;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.textContent = options.confirmLabel;
      dialog.append(title, message, cancel, confirm);
      parent.append(dialog);
      return new Promise<boolean>((resolve) => {
        const settle = (answer: boolean) => {
          if (!open.delete(close)) {
            return;
          }
          dialog.close();
          dialog.remove();
          resolve(answer);
        };
        const close = () => settle(false);
        open.add(close);
        cancel.addEventListener('click', () => settle(false));
        confirm.addEventListener('click', () => settle(true));
        dialog.addEventListener('cancel', (event) => {
          event.preventDefault();
          settle(false);
        });
        dialog.showModal();
        cancel.focus();
      });
    },
    closeAll() {
      for (const close of [...open]) {
        close();
      }
    },
  };
}
