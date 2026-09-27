/**
 * Verified request identity (docs/application.md#interface,
 * docs/application.md#construction-and-request-boundary).
 *
 * Application derives the account from verified authentication context only; a caller-supplied
 * owner or account field never reaches a private operation. The deployed environment verifies the
 * JWT and hands the claims to {@link createClaimsIdentityVerifier}, which re-checks the issuing
 * pool, the app client and the validity of this environment's tokens, so a token of another
 * environment's identity is rejected rather than accepted as an unknown caller. An environment may
 * supply another {@link IdentityVerifier}; the transport boundary and the trusted-context handoff
 * stay the same.
 *
 * The account identity Application derives is the verified subject itself; the bound on an
 * identifier a private operation accepts belongs to the owning component's contract, which rejects
 * an out-of-range account context before it reaches a private record.
 */

/** Account identity Application derived from verified authentication. */
export interface AuthenticatedIdentity {
  /** Account the invocation is authorized for; the storage scope of every private operation. */
  readonly accountId: string;
}

/** Authentication evidence one transport presents to the identity verifier. */
export interface TransportAuthentication {
  /** Bearer credential an HTTP transport carries, when it presents one. */
  readonly bearerToken?: string | null;
  /**
   * Claims a trusted authenticating proxy verified, for example the API Gateway JWT authorizer
   * context. Application re-checks the environment's issuer, audience and validity.
   */
  readonly claims?: Readonly<Record<string, unknown>> | null;
}

/**
 * Verifies one request's authentication. `null` means the evidence is missing, invalid, expired or
 * issued for another environment, and Application rejects the invocation without running it. A
 * thrown failure is an unavailable identity provider, not an invalid caller.
 */
export interface IdentityVerifier {
  verify(
    evidence: TransportAuthentication | null | undefined,
  ): AuthenticatedIdentity | null | Promise<AuthenticatedIdentity | null>;
}

/** Issuer and app client one environment's tokens must carry. */
export interface ClaimsIdentitySettings {
  readonly issuer: string;
  readonly appClientId: string;
}

export interface ClaimsIdentityOptions {
  /** Current time in milliseconds; tests control expiry without changing the system clock. */
  readonly now?: () => number;
}

/**
 * Verifies the claims of this environment's Cognito tokens. The deployed API Gateway verifies the
 * signature before the invocation; this boundary additionally requires the configured issuer, the
 * configured app client and an unexpired token, so a development or test token never authorizes a
 * production request and the reverse. Bearer credentials whose claims were not verified are not
 * accepted.
 */
export function createClaimsIdentityVerifier(
  settings: ClaimsIdentitySettings,
  options: ClaimsIdentityOptions = {},
): IdentityVerifier {
  const issuer = settings?.issuer;
  const appClientId = settings?.appClientId;
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new TypeError('createClaimsIdentityVerifier requires the issuing pool URL.');
  }
  if (typeof appClientId !== 'string' || appClientId.length === 0) {
    throw new TypeError('createClaimsIdentityVerifier requires the app client identity.');
  }
  const now = options.now ?? Date.now;

  return {
    verify(evidence) {
      const claims = readClaims(evidence?.claims);
      if (claims === null || claims.iss !== issuer) {
        return null;
      }
      if (
        !readTokenUse(claims) ||
        !readAudience(claims, appClientId) ||
        !readExpiry(claims, now())
      ) {
        return null;
      }
      const subject = claims.sub;
      if (typeof subject !== 'string' || subject.length === 0) {
        return null;
      }
      return { accountId: subject };
    },
  };
}

/**
 * Reads the trusted account context one verified identity authorizes, or null for an anonymous
 * caller. A verifier that returns no usable account reference authorizes nothing.
 */
export async function readAuthenticatedIdentity(
  verifier: IdentityVerifier,
  evidence: TransportAuthentication | null | undefined,
): Promise<AuthenticatedIdentity | null> {
  const identity = await verifier.verify(evidence);
  if (identity === null || identity === undefined) {
    return null;
  }
  const accountId = identity.accountId;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return null;
  }
  return { accountId };
}

/** Resolves one verified identity into the trusted context private contracts require. */
export function trustedContextFor(
  identity: AuthenticatedIdentity | null,
): { readonly accountId: string } | null {
  return identity === null ? null : { accountId: identity.accountId };
}

/**
 * Whether a transport presented authentication at all. An invocation without evidence runs a
 * public operation anonymously; one whose evidence cannot be verified is rejected instead of being
 * downgraded to anonymous.
 */
export function hasAuthenticationEvidence(
  evidence: TransportAuthentication | null | undefined,
): boolean {
  if (typeof evidence?.bearerToken === 'string' && evidence.bearerToken.length > 0) {
    return true;
  }
  const claims = evidence?.claims;
  return typeof claims === 'object' && claims !== null && Object.keys(claims).length > 0;
}

function readClaims(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Rejects a token of another kind when the issuer reports one; Cognito issues `id` and `access`. */
function readTokenUse(claims: Readonly<Record<string, unknown>>): boolean {
  const tokenUse = claims.token_use;
  return tokenUse === undefined || tokenUse === 'id' || tokenUse === 'access';
}

/** The configured app client must be the token's audience: `aud` for an ID token, `client_id` for an access token. */
function readAudience(claims: Readonly<Record<string, unknown>>, appClientId: string): boolean {
  if (claims.client_id === appClientId) {
    return true;
  }
  const audience = claims.aud;
  if (typeof audience === 'string') {
    return audience === appClientId;
  }
  return Array.isArray(audience) && audience.some((entry) => entry === appClientId);
}

/** Cognito reports expiry in whole seconds since the epoch. */
function readExpiry(claims: Readonly<Record<string, unknown>>, now: number): boolean {
  const exp = claims.exp;
  return typeof exp === 'number' && Number.isFinite(exp) && exp > Math.floor(now / 1000);
}
