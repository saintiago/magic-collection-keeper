/** Lambda entry point of the independently deployed UserCards runtime. */

import {
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createUserCardsServingDeployment,
  type ServingDeployment,
} from '../deployment.js';
import { ConfigurationError } from '../index.js';

let runtime: ServingDeployment | null = null;

function servingRuntime(): ServingDeployment {
  if (runtime !== null) return runtime;
  try {
    runtime = createUserCardsServingDeployment({
      environment: process.env,
      diagnostics: createConsoleDiagnostics(),
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      console.error(`Invalid UserCards serving configuration: ${cause.message}`);
    }
    throw cause;
  }
  return runtime;
}

export const handler = createApiGatewayHandler({
  handle: (request) => servingRuntime().handle(request),
});
