/**
 * Application configuration (docs/application.md#configuration-and-lifecycle).
 *
 * One configuration identifies the environment, the resources, the credential references and the
 * enabled capabilities of that environment. Every value is explicit: there is no inherited default
 * that could point a development or test deployment at production identity or storage. Validation
 * runs before the application accepts any work, and only the projection in
 * {@link readPublicSettings} may reach the browser — it contains no resource ARNs, secret
 * references, database or bucket names.
 */

import { z } from 'zod';

export const applicationEnvironments = ['development', 'test', 'production'] as const;
export type ApplicationEnvironment = (typeof applicationEnvironments)[number];

/** Bounds Application enforces on the configuration it accepts. */
export const APPLICATION_LIMITS = {
  /** Shortest and longest request deadline; the deployed runtime bounds the upper end. */
  minRequestTimeoutMs: 1,
  maxRequestTimeoutMs: 15 * 60 * 1000,
  /** Longest Cognito app client identity accepted from the environment. */
  maxAppClientIdLength: 128,
  /** Longest S3 key prefix one catalog snapshot source may name. */
  maxBucketPrefixLength: 1024,
} as const;

const regionSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, 'Use an AWS region such as us-east-1.');

/** An http(s) URL; production additionally requires https. */
const urlSchema = z
  .url()
  .refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    'Use an http or https URL.',
  );

const resourceArnSchema = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+/,
    'Use the ARN of an existing AWS resource.',
  );

const bucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Use an S3 bucket name.');

const databaseResourceSchema = z.object({
  /** Aurora cluster the executor reaches through the RDS Data API. */
  resourceArn: resourceArnSchema,
  /** Secrets Manager reference the executor resolves; never a credential value. */
  secretArn: resourceArnSchema,
  /** Database name inside the cluster. */
  database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Use a database name.'),
});

const configurationFields = z.object({
  environment: z.enum(applicationEnvironments),
  /** Region of the deployment's AWS resources and workload credentials. */
  region: regionSchema,
  browser: z.object({
    /** Base URL the browser uses to reach the interactive API entry point. */
    apiBaseUrl: urlSchema,
  }),
  resources: z.object({
    catalogDatabase: databaseResourceSchema,
    searchDatabase: databaseResourceSchema,
    userCardsDatabase: databaseResourceSchema,
    catalogSnapshots: z.object({
      bucket: bucketSchema,
      prefix: z
        .string()
        .min(1)
        .max(APPLICATION_LIMITS.maxBucketPrefixLength)
        .nullable()
        .default(null),
    }),
  }),
  authentication: z.object({
    /** Cognito issuer of this environment's user pool. */
    issuer: urlSchema,
    /** App client this environment's tokens are issued for. */
    appClientId: z.string().min(1).max(APPLICATION_LIMITS.maxAppClientIdLength),
    /** Region the browser signs in against. */
    region: regionSchema,
  }),
  recognition: z.object({
    /** Base URL of the recognition compute entry point, or null when cloud engines are off. */
    computeBaseUrl: urlSchema.nullable(),
  }),
  capabilities: z.object({
    /** Enables the remote recognition engines behind the compute entry point. */
    cloudRecognition: z.boolean(),
    /** Enables parsing pasted lists, Moxfield decks and reviewed Wizards lists. */
    sourceImports: z.boolean(),
  }),
  transport: z.object({
    /** Deadline Application enforces on one backend invocation. */
    requestTimeoutMs: z
      .number()
      .int()
      .min(APPLICATION_LIMITS.minRequestTimeoutMs)
      .max(APPLICATION_LIMITS.maxRequestTimeoutMs),
  }),
});

function validateRuntimeConfiguration(
  value: ApplicationRuntimeConfiguration,
  context: z.RefinementCtx,
): void {
  const computeBaseUrl = value.recognition.computeBaseUrl;
  if (value.capabilities.cloudRecognition && computeBaseUrl === null) {
    context.addIssue({
      code: 'custom',
      path: ['recognition', 'computeBaseUrl'],
      message: 'An enabled recognition compute entry point requires its base URL.',
    });
  }
  if (!value.capabilities.cloudRecognition && computeBaseUrl !== null) {
    context.addIssue({
      code: 'custom',
      path: ['recognition', 'computeBaseUrl'],
      message: 'A disabled recognition compute entry point must not name a base URL.',
    });
  }
  if (value.environment !== 'production') {
    return;
  }
  if (value.browser.apiBaseUrl.startsWith('http://')) {
    context.addIssue({
      code: 'custom',
      path: ['browser', 'apiBaseUrl'],
      message: 'Production URLs require https.',
    });
  }
  if (computeBaseUrl !== null && computeBaseUrl.startsWith('http://')) {
    context.addIssue({
      code: 'custom',
      path: ['recognition', 'computeBaseUrl'],
      message: 'Production URLs require https.',
    });
  }
  if (value.authentication.issuer.startsWith('http://')) {
    context.addIssue({
      code: 'custom',
      path: ['authentication', 'issuer'],
      message: 'Production URLs require https.',
    });
  }
}

const configurationSchema = configurationFields.superRefine(validateRuntimeConfiguration);

/**
 * Configuration of one deployment environment: its environment, resources, credential references,
 * identity and enabled capabilities. Development, test and production each supply their own
 * settings; nothing is inherited between them.
 */
export interface ApplicationConfiguration {
  readonly environment: ApplicationEnvironment;
  readonly region: string;
  readonly browser: {
    readonly apiBaseUrl: string;
  };
  readonly resources: {
    readonly catalogDatabase: ApplicationDatabaseResource;
    /** Search's own query credential; it reaches Search's published projection only. */
    readonly searchDatabase: ApplicationDatabaseResource;
    readonly userCardsDatabase: ApplicationDatabaseResource;
    readonly catalogSnapshots: {
      readonly bucket: string;
      readonly prefix: string | null;
    };
  };
  readonly authentication: {
    readonly issuer: string;
    readonly appClientId: string;
    readonly region: string;
  };
  readonly recognition: {
    readonly computeBaseUrl: string | null;
  };
  readonly capabilities: {
    readonly cloudRecognition: boolean;
    readonly sourceImports: boolean;
  };
  readonly transport: {
    readonly requestTimeoutMs: number;
  };
}

/** Credential reference and coordinates of one Aurora database. */
export interface ApplicationDatabaseResource {
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
}

/** The settings the browser may receive, and nothing else. */
export interface PublicApplicationSettings {
  readonly environment: ApplicationEnvironment;
  readonly apiBaseUrl: string;
  readonly authentication: {
    readonly region: string;
    readonly appClientId: string;
  };
  readonly recognition: {
    readonly cloudEnabled: boolean;
    /** Base URL of the compute entry point, or null when cloud engines are disabled. */
    readonly computeBaseUrl: string | null;
  };
  readonly capabilities: {
    readonly sourceImports: boolean;
  };
}

const publicSettingsSchema = z
  .object({
    environment: z.enum(applicationEnvironments),
    apiBaseUrl: urlSchema,
    authentication: z.object({
      region: regionSchema,
      appClientId: z.string().min(1).max(APPLICATION_LIMITS.maxAppClientIdLength),
    }),
    recognition: z.object({
      cloudEnabled: z.boolean(),
      computeBaseUrl: urlSchema.nullable(),
    }),
    capabilities: z.object({
      sourceImports: z.boolean(),
    }),
  })
  .strict();

/**
 * One configuration or public-settings problem. Only field locations and rule descriptions are
 * reported: no supplied value, resource ARN, secret reference or credential appears in the error.
 */
export class ConfigurationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 0
        ? 'The application configuration is invalid.'
        : `The application configuration is invalid: ${problems.join('; ')}`,
    );
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/** Validates one raw configuration before any component or entry point accepts work. */
export function resolveApplicationConfiguration(value: unknown): ApplicationConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigurationError(problemList(parsed.error));
  }
  return parsed.data;
}

/** Runtime policy is independent of the selected storage resources. */
export type ApplicationRuntimeConfiguration = Omit<ApplicationConfiguration, 'resources'>;
const runtimeConfigurationSchema = configurationFields
  .omit({ resources: true })
  .superRefine(validateRuntimeConfiguration);
export function resolveRuntimeConfiguration(value: unknown): ApplicationRuntimeConfiguration {
  const parsed = runtimeConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new ConfigurationError(problemList(parsed.error));
  return parsed.data;
}

/** Validates the public settings a browser received, rejecting any private setting beside them. */
export function resolvePublicSettings(value: unknown): PublicApplicationSettings {
  const parsed = publicSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigurationError(problemList(parsed.error));
  }
  return parsed.data;
}

/** Projects only the public settings of a validated configuration. */
export function readPublicSettings(
  configuration: ApplicationRuntimeConfiguration,
): PublicApplicationSettings {
  return {
    environment: configuration.environment,
    apiBaseUrl: configuration.browser.apiBaseUrl,
    authentication: {
      region: configuration.authentication.region,
      appClientId: configuration.authentication.appClientId,
    },
    recognition: {
      cloudEnabled: configuration.capabilities.cloudRecognition,
      computeBaseUrl: configuration.recognition.computeBaseUrl,
    },
    capabilities: {
      sourceImports: configuration.capabilities.sourceImports,
    },
  };
}

function problemList(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}
