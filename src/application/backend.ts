/**
 * Application backend entry point (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The backend entry points are the interactive transport and the finite catalog job:
 * `createApplication` validates one environment's settings before serving, receives Catalog,
 * UserCards, Search and the catalog job through their public contracts, derives trusted user context
 * from verified authentication only, maps every component failure to one distinct transport outcome
 * and exposes the public settings the browser may receive. Catalog synchronization stays a separate
 * job entry point, and Recognition has its own compute entry point; recognition inference never
 * runs in the interactive transport, and no entry point exposes resource or credential settings.
 *
 * Construction and the provider failure translation live here, beside the provider-owned error
 * types, so the browser bundle of ./index.ts never reaches a backend module. A backend runtime
 * imports the composition from this module and the runtime-independent contract from ./index.ts.
 */

export {
  createApplication,
  type Application,
  type ApplicationDependencies,
  type ApplicationComponents,
} from './internal/application.js';
export { translateFailure } from './internal/errors.js';

export {
  createPostgresApplication,
  type ApplicationResources,
  type PostgresApplicationDependencies,
} from './internal/postgres-composition.js';
