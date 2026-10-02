/**
 * Legacy combined interactive entry point retained for migration compatibility.
 *
 * Production packaging uses the independent entry points under ./entrypoints/. This module remains
 * available while the deployed two-stack service is adopted and its routes move without behavior
 * changes.
 */

import {
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createInteractiveDeployment,
  type InteractiveDeployment,
} from './deployment.js';
import { ConfigurationError } from './index.js';

let runtime: InteractiveDeployment | null = null;

function servingRuntime(): InteractiveDeployment {
  if (runtime !== null) return runtime;
  try {
    runtime = createInteractiveDeployment({
      environment: process.env,
      diagnostics: createConsoleDiagnostics(),
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      console.error(`Invalid runtime configuration: ${cause.message}`);
    }
    throw cause;
  }
  return runtime;
}

export const handler = createApiGatewayHandler({
  handle: (request) => servingRuntime().application.handle(request),
});
