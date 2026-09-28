/**
 * Brief question contract the shell provides to the views it presents
 * (docs/ui/pages.md#interface, docs/ui/navigation.md).
 *
 * A view asks one question and receives the user's decision; the shell owns the presentation of
 * the dialog. Only text the caller supplied is rendered, so external text stays safe.
 */

export interface UiDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

/** Dialogs the shell provides to the page and editors it presents. */
export interface UiDialogs {
  /** Asks one brief question; false when the user cancels or the view closes. */
  confirm(options: UiDialogOptions): Promise<boolean>;
}
