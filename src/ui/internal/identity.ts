/**
 * Identity boundary of the UserInterface (docs/user-interface.md#interface,
 * docs/user-interface.md#capture-and-review).
 *
 * Application supplies the authenticated transport and the public configuration; the deployment's
 * authentication supplies this capability, which reports the verified account and its transitions.
 * The shell never decodes credentials itself: it presents what identity reports and isolates
 * private presentation state by the reported account.
 */

/** One verified account the presentation keeps private state apart for. */
export interface UiAccount {
  /** Verified account identity, stable across sign-ins of the same account. */
  readonly accountId: string;
  /** Name to present for the account, or null when the deployment reports none. */
  readonly displayName: string | null;
}

/** Identity capability the deployment supplies to the UserInterface. */
export interface UiIdentity {
  /** Current verified account, or null while the visitor is signed out. */
  current(): UiAccount | null;
  /** Starts the deployment's sign-in interaction. */
  signIn(): void | Promise<void>;
  /** Ends the session in the deployment's authentication. */
  signOut(): void | Promise<void>;
  /** Reports verified-account changes, including sign-out; returns the unsubscribe function. */
  subscribe(listener: (account: UiAccount | null) => void): () => void;
}

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
