/**
 * Application public entry point (docs/application.md).
 *
 * Application owns configuration, identity integration, component assembly, the backend transports
 * and the runtime lifecycle (docs/architecture.md). The backend entry points are the interactive
 * transport and the finite catalog job: `createApplication` validates one environment's settings
 * before serving, constructs Catalog, UserCards, Search and the catalog job through their public
 * contracts, derives trusted user context from verified authentication only, maps every component
 * failure to one distinct transport outcome and exposes the public settings the browser may receive.
 * Catalog synchronization stays a separate job entry point, and Recognition has its own compute
 * entry point: the browser reaches it through the authenticated request and the preserved engines
 * keep their catalog-hydration envelopes. Recognition inference never runs in the interactive
 * transport, and neither entry point exposes resource or credential settings.
 *
 * The browser side composes the same contracts for the running environment:
 * `createBrowserApplication` validates the public settings, builds the authenticated request, the
 * Catalog read client and the Recognition contract over the preserved browser engines, and hands
 * UserInterface its capabilities. Other components import Application through this module only; its
 * internal modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
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
  createApplication,
  type Application,
  type ApplicationDependencies,
  type ApplicationResources,
} from './internal/application.js';
export {
  createBrowserApplication,
  createAuthenticatedRequest,
  createCatalogClient,
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
  ApplicationError,
  applicationFailureCodes,
  isApplicationFailureCode,
  translateFailure,
  transportStatus,
  type ApplicationFailureCode,
} from './internal/errors.js';
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
