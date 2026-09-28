/**
 * Interactive entry point of the deployed backend
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The artifact names this module's `handler` export, so one invocation of the interactive API
 * becomes one request on the boundary {@link createApiGatewayHandler} builds. The runtime is
 * constructed on the first invocation from this environment's variables and kept warm afterwards:
 * every invocation keeps its own identity, deadline and diagnostic record, while the reusable Data
 * API client stays between them (docs/application.md#configuration-and-lifecycle).
 */

import {
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createInteractiveDeployment,
  type InteractiveDeployment,
} from './deployment.js';
import { ConfigurationError } from './index.js';

let runtime: InteractiveDeployment | null = null;

/** The warm runtime of this execution environment, constructed and validated on first use. */
function servingRuntime(): InteractiveDeployment {
  if (runtime !== null) {
    return runtime;
  }
  try {
    runtime = createInteractiveDeployment({
      environment: process.env,
      diagnostics: createConsoleDiagnostics(),
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      // The problem names the variables this runtime requires and never carries their values, so
      // an operator sees why the function answers unavailable instead of only the failed alarm.
      console.error(`Invalid runtime configuration: ${cause.message}`);
    }
    throw cause;
  }
  return runtime;
}

export const handler = createApiGatewayHandler({
  handle: (request) => servingRuntime().application.handle(request),
});
