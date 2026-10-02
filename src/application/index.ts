/**
 * Application public entry point (docs/application.md).
 *
 * Application owns configuration, identity integration, component assembly, the backend transports
 * and the runtime lifecycle (docs/architecture.md). It serves two runtimes through two public
 * entries: this module is the runtime-independent contract a browser bundle loads — configuration
 * and public settings, the verified-claims identity boundary, the failure vocabulary, the routes
 * and authenticated transports, the Catalog read client and the browser composition — while
 * ./backend.ts assembles the interactive backend application, the finite catalog job and the
 * provider failure translation a browser must never reach.
 *
 * The browser side composes the same contracts for the running environment:
 * `createBrowserApplication` validates the public settings, builds the authenticated request, the
 * Catalog and UserCards clients and the Recognition contract over the preserved browser engines,
 * composes UserCards' browser operation facade over the transport adapter it serves, and hands
 * UserInterface its capabilities. Other components import Application through these public entries
 * only; its internal modules stay private to the component (docs/architecture.md,
 * .dependency-cruiser.mjs).
 */

export {
  APPLICATION_LIMITS,
  applicationEnvironments,
  ConfigurationError,
  readPublicSettings,
  resolveApplicationConfiguration,
  resolvePublicSettings,
  type ApplicationConfiguration,
  type ApplicationDatabaseResource,
  type ApplicationEnvironment,
  type PublicApplicationSettings,
} from './internal/configuration.js';
export {
  createBrowserApplication,
  createAuthenticatedRequest,
  createCatalogClient,
  createUserCardsClient,
  inspectCanvasFrame,
  type AuthenticatedRequest,
  type AuthenticatedRequestInit,
  type AuthenticatedRequestOptions,
  type BrowserApplication,
  type BrowserApplicationOptions,
  type RequestTransport,
  type UserInterfaceCapabilities,
} from './internal/client.js';
export {
  createBrowserAuthentication,
  createBrowserSessionStore,
  type BrowserAccount,
  type BrowserAuthentication,
  type BrowserAuthenticationOptions,
  type BrowserCredentialPrompt,
  type BrowserIdentity,
  type BrowserSessionStore,
} from './internal/browser-authentication.js';
export {
  ApplicationError,
  applicationFailureCodes,
  isApplicationFailureCode,
  transportStatus,
  type ApplicationFailureCode,
} from './internal/failures.js';
export {
  createClaimsIdentityVerifier,
  type AuthenticatedIdentity,
  type ClaimsIdentityOptions,
  type ClaimsIdentitySettings,
  type IdentityVerifier,
  type TransportAuthentication,
} from './internal/identity.js';
export type { DiagnosticEvent, Diagnostics } from './internal/diagnostics.js';
export {
  applicationPath,
  type TransportRequest,
  type TransportResponse,
} from './internal/transport.js';
export { applicationRoutes, type ApplicationRouteName } from './internal/paths.js';
