/** Configuration and request composition shared by the two serving runtimes. */

import { z } from 'zod';

import { ConfigurationError } from './configuration.js';
import type { DataApiClient } from './data-api.js';
import type { Diagnostics } from './diagnostics.js';
import { createClaimsIdentityVerifier } from './identity.js';
import type { RequestTransport } from './client.js';
import type { TransportRequest, TransportResponse } from './transport.js';

const environmentSchema = z.enum(['development', 'test', 'production']);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
const poolSchema = z.string().regex(/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}$/);

export interface ServiceIdentity {
  readonly environment: z.infer<typeof environmentSchema>;
  readonly region: string;
  readonly clusterArn: string;
  readonly database: string;
  readonly poolId: string;
  readonly appClientId: string;
  readonly requestTimeoutMs: number;
}

export interface ServingDeployment {
  handle(request: TransportRequest): Promise<TransportResponse>;
  dispose(): void;
}

export interface ServingDeploymentOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly dataApi?: DataApiClient;
  readonly diagnostics?: Diagnostics;
  readonly fetch?: typeof globalThis.fetch;
  readonly catalogRequest?: RequestTransport;
}

export function readServingIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): ServiceIdentity {
  const parsedEnvironment = environmentSchema.safeParse(
    requiredServingVariable(environment, 'KEEPER_ENVIRONMENT'),
  );
  const region = regionSchema.safeParse(requiredServingVariable(environment, 'AWS_REGION'));
  const pool = poolSchema.safeParse(requiredServingVariable(environment, 'KEEPER_USER_POOL_ID'));
  const timeout = Number(requiredServingVariable(environment, 'KEEPER_REQUEST_TIMEOUT_MS'));
  const problems: string[] = [];
  if (!parsedEnvironment.success)
    problems.push('KEEPER_ENVIRONMENT: use development, test or production.');
  if (!region.success) problems.push('AWS_REGION: use an AWS region such as us-east-1.');
  if (!pool.success) problems.push('KEEPER_USER_POOL_ID: use a Cognito user pool identifier.');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15 * 60 * 1000) {
    problems.push('KEEPER_REQUEST_TIMEOUT_MS: use a bounded whole number of milliseconds.');
  }
  if (problems.length > 0 || !parsedEnvironment.success || !region.success || !pool.success) {
    throw new ConfigurationError(problems);
  }
  return {
    environment: parsedEnvironment.data,
    region: region.data,
    clusterArn: requiredServingVariable(environment, 'KEEPER_DATABASE_CLUSTER_ARN'),
    database: requiredServingVariable(environment, 'KEEPER_DATABASE_NAME'),
    poolId: pool.data,
    appClientId: requiredServingVariable(environment, 'KEEPER_USER_POOL_CLIENT_ID'),
    requestTimeoutMs: timeout,
  };
}

export function servingIdentityVerifier(identity: ServiceIdentity) {
  return createClaimsIdentityVerifier({
    issuer: `https://cognito-idp.${identity.region}.amazonaws.com/${identity.poolId}`,
    appClientId: identity.appClientId,
  });
}

export function requiredServingVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError([`${name}: this runtime requires the variable.`]);
  }
  return value;
}

export function sourceImportsEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = requiredServingVariable(environment, 'KEEPER_SOURCE_IMPORTS');
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationError(['KEEPER_SOURCE_IMPORTS: use true or false.']);
}
