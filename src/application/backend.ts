/**
 * Application backend entry point (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The backend contract supports the serving transports and finite Catalog job. Production selects
 * separate Catalog-serving and UserCards entry points under ./entrypoints/.
 * Application receives Catalog and UserCards through their public contracts, derives trusted
 * user context from verified authentication, and maps component failures to transport outcomes.
 * Recognition has its own compute entry point; inference never runs in the interactive transport,
 * and no entry point exposes resource or credential settings.
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
