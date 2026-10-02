/** Environment parsing and client cleanup shared by legacy serving and finite-job wiring. */

import { z } from 'zod';

import { ConfigurationError } from './configuration.js';

const environmentSchema = z.enum(['development', 'test', 'production']);
const regionSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, 'Use an AWS region such as us-east-1.');

export function readRuntimeIdentity(environment: Readonly<Record<string, string | undefined>>): {
  readonly environment: z.infer<typeof environmentSchema>;
  readonly region: string;
} {
  const problem = environmentSchema.safeParse(requiredVariable(environment, 'KEEPER_ENVIRONMENT'));
  if (!problem.success) {
    throw new ConfigurationError(['KEEPER_ENVIRONMENT: use development, test or production.']);
  }
  const region = regionSchema.safeParse(requiredVariable(environment, 'AWS_REGION'));
  if (!region.success) {
    throw new ConfigurationError([
      `AWS_REGION: ${region.error.issues[0]?.message ?? 'Use an AWS region such as us-east-1.'}`,
    ]);
  }
  return { environment: problem.data, region: region.data };
}

export function requiredVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError([`${name}: this runtime requires the variable.`]);
  }
  return value;
}

export function optionalVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function destroyClient(client: object): void {
  const destroy = Reflect.get(client, 'destroy');
  if (typeof destroy === 'function') {
    destroy.call(client);
  }
}
