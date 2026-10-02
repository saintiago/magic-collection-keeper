/** Lambda entry point of the independently deployed Catalog serving runtime. */

import {
  createApiGatewayHandler,
  createCatalogServingDeployment,
  createConsoleDiagnostics,
  withoutInternalCatalogPrefix,
  type ServingDeployment,
} from '../deployment.js';
import { ConfigurationError } from '../index.js';

let runtime: ServingDeployment | null = null;

function servingRuntime(): ServingDeployment {
  if (runtime !== null) return runtime;
  try {
    runtime = createCatalogServingDeployment({
      environment: process.env,
      diagnostics: createConsoleDiagnostics(),
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      console.error(`Invalid Catalog serving configuration: ${cause.message}`);
    }
    throw cause;
  }
  return runtime;
}

const dispatch = createApiGatewayHandler({
  handle: (request) => servingRuntime().handle(request),
});

export const handler = (event: unknown) => dispatch(withoutInternalCatalogPrefix(event));
