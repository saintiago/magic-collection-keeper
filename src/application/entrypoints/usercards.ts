/** Lambda entry point of the independently deployed UserCards runtime. */

import { ConfigurationError } from '../internal/configuration.js';
import {
  createApiGatewayHandler,
  createConsoleDiagnostics,
} from '../internal/lambda-deployment.js';
import type { ServingDeployment } from '../internal/serving-deployment-shared.js';
import { createUserCardsServingDeployment } from '../internal/usercards-serving-deployment.js';

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
