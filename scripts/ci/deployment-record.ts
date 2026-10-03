import { createHash } from 'node:crypto';

export const deploymentUnits = [
  'foundation',
  'gateway',
  'web',
  'catalog-serving',
  'usercards',
  'recognition',
  'catalog-ingestion',
] as const;

export type DeploymentUnit = (typeof deploymentUnits)[number];

export interface ArtifactIdentity {
  readonly kind: 'files' | 'image' | 'none';
  /** Content identities only. Source provenance is recorded separately. */
  readonly values: Readonly<Record<string, string>>;
}

export interface VerificationRecord {
  readonly status: 'passed';
  readonly checkedAt: string;
  readonly evidence: readonly string[];
}

export interface ComponentDeploymentRecord {
  readonly sourceRevision: string;
  readonly stackName: string;
  readonly templateSha256: string;
  readonly configurationSha256: string;
  /** Environment-owned settings, excluding immutable artifact parameters. */
  readonly environmentConfigurationSha256: string;
  readonly templateUri: string;
  readonly configurationUri: string;
  readonly evidenceUri: string;
  readonly artifact: ArtifactIdentity;
  readonly inputs: readonly string[];
  readonly verification: VerificationRecord;
  readonly previousRestorableVersion: RestorableVersion | null;
}

export interface RestorableVersion {
  readonly sourceRevision: string;
  readonly templateSha256: string;
  readonly configurationSha256: string;
  readonly environmentConfigurationSha256: string;
  readonly templateUri: string;
  readonly configurationUri: string;
  readonly evidenceUri: string;
  readonly artifact: ArtifactIdentity;
}

export interface DeploymentRecord {
  readonly schema: 1;
  readonly environment: 'test' | 'production';
  /** The revision through which every selected deployment completed and was verified. */
  readonly revision: string;
  readonly updatedAt: string;
  /** Immutable finalized combination identity, independent of source revision. */
  readonly releaseId?: string;
  readonly components: Partial<Record<DeploymentUnit, ComponentDeploymentRecord>>;
}

export interface DeploymentAttempt {
  readonly schema: 1;
  readonly environment: 'test' | 'production';
  readonly unit: DeploymentUnit;
  readonly sourceRevision: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly outcome: 'failed' | 'verified';
  readonly resultingIdentity: {
    readonly templateSha256: string;
    readonly configurationSha256: string;
    readonly artifact: ArtifactIdentity;
  };
  readonly detail: string;
}

export function contentIdentity(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function componentChanged(
  previous: ComponentDeploymentRecord | undefined,
  desired: Pick<ComponentDeploymentRecord, 'templateSha256' | 'configurationSha256' | 'artifact'>,
): boolean {
  if (previous === undefined) return true;
  return (
    previous.templateSha256 !== desired.templateSha256 ||
    previous.configurationSha256 !== desired.configurationSha256 ||
    contentIdentity(previous.artifact) !== contentIdentity(desired.artifact)
  );
}

/**
 * Replaces one component only after live verification. The former verified identity remains the
 * rollback source; source labels never participate in content comparison.
 */
export function recordVerifiedComponent(
  record: DeploymentRecord,
  unit: DeploymentUnit,
  component: Omit<ComponentDeploymentRecord, 'previousRestorableVersion'>,
): DeploymentRecord {
  const previous = record.components[unit];
  const previousRestorableVersion =
    previous === undefined
      ? null
      : !componentChanged(previous, component)
        ? previous.previousRestorableVersion
        : {
            sourceRevision: previous.sourceRevision,
            templateSha256: previous.templateSha256,
            configurationSha256: previous.configurationSha256,
            environmentConfigurationSha256: previous.environmentConfigurationSha256,
            templateUri: previous.templateUri,
            configurationUri: previous.configurationUri,
            evidenceUri: previous.evidenceUri,
            artifact: previous.artifact,
          };
  return {
    ...record,
    components: {
      ...record.components,
      [unit]: { ...component, previousRestorableVersion },
    },
  };
}

/** Advances the planner baseline only after every selected component has verified successfully. */
export function finalizeDeploymentRecord(
  record: DeploymentRecord,
  revision: string,
  updatedAt: string,
): DeploymentRecord {
  assertRevision(revision);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('updatedAt must be an ISO instant.');
  const releaseId = contentIdentity({
    environment: record.environment,
    revision,
    components: record.components,
  });
  return { ...record, revision, updatedAt, releaseId };
}

/** Rejects a revision that would move either the finalized baseline or a verified component back. */
export async function assertFreshRevision(
  record: DeploymentRecord,
  revision: string,
  isAncestor: (deployed: string, candidate: string) => Promise<boolean>,
): Promise<void> {
  assertRevision(revision);
  const deployedRevisions = new Set([
    record.revision,
    ...Object.values(record.components).map((component) => component.sourceRevision),
  ]);
  deployedRevisions.delete('0000000000000000000000000000000000000000');
  for (const deployed of deployedRevisions) {
    assertRevision(deployed);
    if (!(await isAncestor(deployed, revision))) {
      throw new Error(`Refusing stale revision ${revision}; ${deployed} is already deployed.`);
    }
  }
}

export function emptyDeploymentRecord(
  environment: DeploymentRecord['environment'],
): DeploymentRecord {
  return {
    schema: 1,
    environment,
    revision: '0000000000000000000000000000000000000000',
    updatedAt: new Date(0).toISOString(),
    components: {},
  };
}

export function readDeploymentRecord(value: unknown): DeploymentRecord {
  const record = asRecord(value);
  if (
    record?.['schema'] !== 1 ||
    (record['environment'] !== 'test' && record['environment'] !== 'production') ||
    typeof record['revision'] !== 'string' ||
    typeof record['updatedAt'] !== 'string' ||
    asRecord(record['components']) === null
  ) {
    throw new Error('The deployment record must be a schema 1 environment record.');
  }
  assertRevision(record['revision']);
  return value as DeploymentRecord;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = asRecord(value);
  if (record !== null) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertRevision(revision: string): void {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('A deployment revision must be a 40-character lowercase Git object ID.');
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
