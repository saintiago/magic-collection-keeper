/**
 * Identity boundary of the UserInterface (docs/ui/architecture.md#interface,
 * docs/ui/capture-controls.md).
 *
 * Application supplies the authenticated transport and the public configuration; the deployment's
 * authentication supplies this capability, which reports the verified account and its transitions.
 * The capability and its verified account are Application's contract — UserInterface presents them
 * and derives nothing from tokens, because the shell never decodes credentials itself: it presents
 * what identity reports and isolates private presentation state by the reported account.
 */

import type { BrowserAccount, BrowserIdentity } from '../../../application/index.js';

/** One verified account the presentation keeps private state apart for (Application's account). */
export type UiAccount = BrowserAccount;

/** Identity capability Application supplies to the UserInterface. */
export type UiIdentity = BrowserIdentity;

/** Reads one verified account; an invalid report counts as signed out, never as a partial account. */
export function readAccount(value: unknown): UiAccount | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const account = value as Readonly<Record<string, unknown>>;
  const accountId = account.accountId;
  const displayName = account.displayName;
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > 128 ||
    (displayName !== null && displayName !== undefined && typeof displayName !== 'string')
  ) {
    return null;
  }
  return {
    accountId,
    displayName: typeof displayName === 'string' && displayName.length > 0 ? displayName : null,
  };
}
