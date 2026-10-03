import { createHash } from 'node:crypto';

export { deploymentUnits, type DeploymentUnit } from '../../infra/deployment-bindings.js';
import type { DeploymentUnit } from '../../infra/deployment-bindings.js';

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
  /** External build settings captured by planning and used by the verified build. */
  readonly buildInputs?: Readonly<Record<string, string>>;
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
  /** Written before mutation; cleared only together with a verified component. */
  readonly pending?: Partial<
    Record<DeploymentUnit, { readonly sourceRevision: string; readonly startedAt: string }>
  >;
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

/** Compare application bytes across environment-owned repositories, buckets and object versions. */
export function portableArtifactIdentity(artifact: ArtifactIdentity): string {
  if (artifact.kind === 'none') return contentIdentity({ kind: 'none' });
  if (artifact.kind === 'image') {
    if (!artifact.values['digest']) throw new Error('An image artifact requires its digest.');
    return contentIdentity({ kind: 'image', digest: artifact.values['digest'] });
  }
  if (artifact.values['files'] !== undefined) {
    const files = JSON.parse(artifact.values['files']) as Record<string, { sha256: string }>;
    const content = Object.fromEntries(
      Object.entries(files)
        .filter(([key]) => key !== 'config.json')
        .map(([key, value]) => {
          if (!value.sha256) throw new Error(`Browser artifact ${key} requires its content hash.`);
          return [key, value.sha256];
        }),
    );
    // config.json is generated from target-environment public settings during promotion.
    return contentIdentity({ kind: 'files', files: content });
  }
  if (!artifact.values['sha256']) throw new Error('A file artifact requires its content hash.');
  return contentIdentity({ kind: 'files', sha256: artifact.values['sha256'] });
}

export function recordPendingComponent(
  record: DeploymentRecord,
  unit: DeploymentUnit,
  sourceRevision: string,
  startedAt: string,
): DeploymentRecord {
  assertRevision(sourceRevision);
  return { ...record, pending: { ...record.pending, [unit]: { sourceRevision, startedAt } } };
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
  const pending = { ...record.pending };
  delete pending[unit];
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
    pending,
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
  assertNoPendingDeployments(record);
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('updatedAt must be an ISO instant.');
  const releaseId = contentIdentity({
    environment: record.environment,
    revision,
    components: record.components,
  });
  return { ...record, revision, updatedAt, releaseId };
}

export function assertNoPendingDeployments(record: DeploymentRecord): void {
  const pending = Object.keys(record.pending ?? {});
  if (pending.length > 0)
    throw new Error(`Unverified deployments require reconciliation: ${pending.join(', ')}.`);
}

/** Rejects revisions older than the finalized baseline, verified components or pending attempts. */
export async function assertFreshRevision(
  record: DeploymentRecord,
  revision: string,
  isAncestor: (deployed: string, candidate: string) => Promise<boolean>,
): Promise<void> {
  assertRevision(revision);
  const deployedRevisions = new Set([
    record.revision,
    ...Object.values(record.components).map((component) => component.sourceRevision),
    ...Object.values(record.pending ?? {}).map((component) => component.sourceRevision),
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
