import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertFreshRevision,
  contentIdentity,
  recordPendingComponent,
  deploymentUnits,
  emptyDeploymentRecord,
  finalizeDeploymentRecord,
  recordVerifiedComponent,
  type ComponentDeploymentRecord,
} from '../../scripts/ci/deployment-record.js';
import {
  buildParameterArguments,
  isDestructiveProtectedChange,
} from '../../scripts/ci/deploy-stack.js';
import {
  collectProductionInputs,
  planDeployments,
  readStackInputMapping,
} from '../../scripts/ci/planner.js';

import { planPromotion } from '../../scripts/ci/promotion-plan.js';

import { createDeploymentPlan } from '../../scripts/ci/plan.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const mappingFile = path.join(root, 'scripts/ci/stack-inputs.json');
const revision = '1'.repeat(40);

describe('selective CI/CD planning', () => {
  it('selects an isolated stack, imported constructs and no stack for validation-only paths', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    const productionInputs = await collectProductionInputs(root);

    const isolated = planDeployments({
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['infra/cdk/stacks/usercards.ts'],
      mapping,
      productionInputs,
    });
    expect(isolated.candidates).toEqual(['usercards']);

    const construct = planDeployments({
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['infra/cdk/constructs/lambda-service.ts'],
      mapping,
      productionInputs,
    });
    expect(construct.candidates).toEqual(['catalog-serving', 'usercards']);

    const validationOnly = planDeployments({
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['docs/ci-cd.md', 'tests/integration/ci-cd.test.ts', 'src/styles.d.ts'],
      mapping,
      productionInputs,
    });
    expect(validationOnly.candidates).toEqual([]);
  });

  it('uses current and last-deployed source graphs so removals still select their consumers', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    const deployed = emptyDeploymentRecord('test');
    const withFormerWebInput = recordVerifiedComponent(deployed, 'web', {
      ...verifiedComponent('keeper-test-web'),
      inputs: ['src/ui/removed-production-module.ts'],
    });
    const plan = planDeployments({
      baseRevision: revision,
      sourceRevision: revision,
      changedPaths: ['src/ui/removed-production-module.ts'],
      mapping,
      productionInputs: { web: [] },
      deployedRecord: withFormerWebInput,
    });
    expect(plan.candidates).toEqual(['web']);
    expect(plan.reasons.web).toEqual(['src/ui/removed-production-module.ts']);
  });

  it.each(deploymentUnits)(
    'reconciles a partial %s deployment even when the next revision reverts to the finalized files',
    async (unit) => {
      const mapping = await readStackInputMapping(mappingFile);
      const baseline = finalizeDeploymentRecord(
        emptyDeploymentRecord('test'),
        revision,
        '2026-10-03T00:00:00Z',
      );
      const partial = recordVerifiedComponent(baseline, unit, {
        ...verifiedComponent(`keeper-test-${unit}`),
        sourceRevision: '2'.repeat(40),
      });
      const plan = planDeployments({
        baseRevision: revision,
        sourceRevision: '3'.repeat(40),
        changedPaths: [], // A..C is empty after reverting B's files.
        mapping,
        productionInputs: {},
        deployedRecord: partial,
      });
      expect(plan.candidates).toContain(unit);
    },
  );

  it.each(deploymentUnits)(
    'reconciles applied but unverified %s after a revert in both environments',
    async (unit) => {
      const mapping = await readStackInputMapping(mappingFile);
      let baseline = emptyDeploymentRecord('test');
      for (const componentUnit of deploymentUnits) {
        baseline = recordVerifiedComponent(
          baseline,
          componentUnit,
          verifiedComponent(`keeper-test-${componentUnit}`),
        );
      }
      baseline = finalizeDeploymentRecord(baseline, revision, '2026-10-03T00:00:00Z');
      // B applies, but its live verification fails. The verified component remains at A.
      const pending = recordPendingComponent(
        baseline,
        unit,
        '2'.repeat(40),
        '2026-10-03T01:00:00Z',
      );
      expect(pending.components).toEqual(baseline.components);
      const plan = planDeployments({
        baseRevision: revision,
        sourceRevision: '3'.repeat(40),
        changedPaths: [],
        mapping,
        productionInputs: {},
        deployedRecord: pending,
      });
      expect(plan.candidates).toContain(unit);
      expect(() =>
        finalizeDeploymentRecord(pending, '3'.repeat(40), '2026-10-03T02:00:00Z'),
      ).toThrow(/Unverified deployments/);
      const configuration = Object.fromEntries(
        deploymentUnits.map((name) => [name, 'c'.repeat(64)]),
      );
      expect(
        planPromotion(baseline, { ...pending, environment: 'production' }, revision, configuration)
          .candidates,
      ).toEqual([unit]);
      expect(() =>
        planPromotion(pending, { ...baseline, environment: 'production' }, revision, configuration),
      ).toThrow(/Unverified deployments/);
      await expect(
        assertFreshRevision(pending, revision, async (deployed) => deployed === revision),
      ).rejects.toThrow(/Refusing stale/);
      // C restores A's bytes and verifies: only then may recovery be cleared and finalized.
      const recovered = recordVerifiedComponent(pending, unit, {
        ...verifiedComponent(`keeper-test-${unit}`),
        sourceRevision: '3'.repeat(40),
      });
      expect(recovered.pending).toEqual({});
      expect(recovered.components[unit]?.artifact).toEqual(baseline.components[unit]?.artifact);
      expect(
        finalizeDeploymentRecord(recovered, '3'.repeat(40), '2026-10-03T02:00:00Z').revision,
      ).toBe('3'.repeat(40));
    },
  );

  it('captures a changed Catalog base image with unchanged Git and CloudFormation settings', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-build-input-plan-'));
    try {
      const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      const firstImage = `node@sha256:${'a'.repeat(64)}`;
      const nextImage = `node@sha256:${'b'.repeat(64)}`;
      const component = {
        ...verifiedComponent('keeper-test-catalog-ingestion'),
        sourceRevision: head,
        environmentConfigurationSha256: contentIdentity({}),
        buildInputs: { NODE_BASE_IMAGE: firstImage },
      };
      let record = emptyDeploymentRecord('test');
      for (const unit of deploymentUnits) {
        record = recordVerifiedComponent(record, unit, {
          ...component,
          buildInputs: unit === 'catalog-ingestion' ? component.buildInputs : {},
        });
        await writeFile(path.join(directory, `${unit}.json`), '{}');
      }
      record = finalizeDeploymentRecord(record, head, '2026-10-03T00:00:00Z');
      const recordFile = path.join(directory, 'current.json');
      const out = path.join(directory, 'plan.json');
      await writeFile(recordFile, JSON.stringify(record));
      const options = {
        base: head,
        head,
        record: recordFile,
        out,
        githubOutput: null,
        configurationDirectory: directory,
      };
      await createDeploymentPlan({ ...options, catalogNodeBaseImage: firstImage });
      expect(JSON.parse(await readFile(out, 'utf8')).candidates).toEqual([]);
      await createDeploymentPlan({ ...options, catalogNodeBaseImage: nextImage });
      const plan = JSON.parse(await readFile(out, 'utf8'));
      expect(plan.candidates).toEqual(['catalog-ingestion']);
      expect(plan.buildInputs['catalog-ingestion']).toEqual({ NODE_BASE_IMAGE: nextImage });
      const verified = recordVerifiedComponent(record, 'catalog-ingestion', {
        ...component,
        buildInputs: plan.buildInputs['catalog-ingestion'],
      });
      await writeFile(recordFile, JSON.stringify(verified));
      await createDeploymentPlan({ ...options, catalogNodeBaseImage: nextImage });
      expect(JSON.parse(await readFile(out, 'utf8')).candidates).toEqual([]);
      await expect(
        createDeploymentPlan({ ...options, catalogNodeBaseImage: 'node:latest' }),
      ).rejects.toThrow(/pinned by digest/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['delete', 'rename'])(
    'plans a credential-free module %s using the real base graph',
    async (operation) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-plan-test-'));
      try {
        const git = (args: string[]) => exec('git', args, { cwd: directory });
        await git(['init', '-q']);
        await git(['config', 'user.email', 'test@example.com']);
        await git(['config', 'user.name', 'Test']);
        for (const name of ['src/application/entrypoints', 'src/ui', 'scripts/ci']) {
          await mkdir(path.join(directory, name), { recursive: true });
        }
        await writeFile(
          path.join(directory, 'scripts/ci/stack-inputs.json'),
          await readFile(mappingFile),
        );
        for (const name of ['catalog-serving', 'usercards', 'catalog-ingestion']) {
          await writeFile(
            path.join(directory, `src/application/entrypoints/${name}.ts`),
            'export const value = 1;',
          );
        }
        for (const name of ['prepare-recognition', 'package-recognition']) {
          await writeFile(path.join(directory, `scripts/${name}.ts`), 'export const value = 1;');
        }
        const entry = path.join(directory, 'src/application/entrypoints/web.ts');
        await writeFile(entry, "export { value } from '../../ui/old.js';");
        await writeFile(
          path.join(directory, 'src/ui/old.ts'),
          "export { value } from 'removed-npm-dependency';",
        );
        await git(['add', '.']);
        await git(['commit', '-qm', 'base']);
        const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        if (operation === 'rename') {
          await git(['mv', 'src/ui/old.ts', 'src/ui/new.ts']);
          await writeFile(entry, "export { value } from '../../ui/new.js';");
          await writeFile(path.join(directory, 'src/ui/new.ts'), 'export const value = 1;');
        } else {
          await rm(path.join(directory, 'src/ui/old.ts'));
          await writeFile(entry, 'export const value = 1;');
        }
        await git(['add', '.']);
        await git(['commit', '-qm', operation]);
        const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        const out = path.join(directory, 'plan.json');
        await createDeploymentPlan(
          { base, head, out, record: null, githubOutput: null, configurationDirectory: null },
          directory,
        );
        const plan = JSON.parse(await readFile(out, 'utf8'));
        expect(plan.candidates).toEqual(['web']);
        expect(plan.reasons.web).toContain('src/ui/old.ts');
        if (operation === 'rename') expect(plan.reasons.web).toContain('src/ui/new.ts');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('maps Recognition preparation and packaging helpers to every artifact they affect', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    const productionInputs = await collectProductionInputs(root);
    expect(productionInputs.web).toContain('src/ui/presentation.css');
    const browserPreparation = planDeployments({
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['src/recognition/python/scripts/browser_assets.py'],
      mapping,
      productionInputs,
    });
    expect(browserPreparation.candidates).toEqual(['web', 'recognition']);

    const packagingHelper = planDeployments({
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['scripts/packaging-support.ts'],
      mapping,
      productionInputs,
    });
    expect(packagingHelper.candidates).toContain('recognition');
    expect(productionInputs.recognition).toContain('scripts/packaging-support.ts');
  });

  it('fails closed for an input absent from the mapping and production graphs', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    expect(() =>
      planDeployments({
        baseRevision: '0'.repeat(40),
        sourceRevision: revision,
        changedPaths: ['unclassified-production-input.bin'],
        mapping,
        productionInputs: {},
      }),
    ).toThrow(/Cannot classify changed input/);
  });

  it('selects a unit when its resolved environment configuration changed outside Git', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    const deployed = recordVerifiedComponent(emptyDeploymentRecord('test'), 'gateway', {
      ...verifiedComponent('keeper-test-gateway'),
      environmentConfigurationSha256: 'a'.repeat(64),
    });
    const plan = planDeployments({
      baseRevision: revision,
      sourceRevision: revision,
      changedPaths: [],
      mapping,
      productionInputs: {},
      deployedRecord: deployed,
      configurationIdentities: { gateway: 'b'.repeat(64) },
    });
    expect(plan.candidates).toEqual([
      'gateway',
      'web',
      'catalog-serving',
      'usercards',
      'recognition',
    ]);
    expect(plan.reasons.gateway).toEqual(['[environment configuration changed]']);
    expect(plan.reasons.web).toEqual(['[provider gateway replanned]']);
  });

  it('keeps one required validation entry and separate reusable stack workflows', async () => {
    const entry = await readFile(path.join(root, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(entry).toContain('pull_request:');
    expect(entry).toContain('push:');
    expect(entry).not.toMatch(/^\s+paths:/m);
    for (const workflow of [
      'deploy-foundation.yml',
      'deploy-gateway.yml',
      'deploy-web.yml',
      'deploy-catalog-serving.yml',
      'deploy-usercards.yml',
      'deploy-recognition.yml',
      'deploy-catalog-ingestion.yml',
    ]) {
      const text = await readFile(path.join(root, '.github/workflows', workflow), 'utf8');
      expect(text, workflow).toContain('workflow_call:');
      expect(text, workflow).toContain('ci:deploy-stack');
      expect(text, workflow).toContain('record-verified');
      expect(text.indexOf('record-pending'), workflow).toBeGreaterThan(0);
      expect(text.indexOf('record-pending'), workflow).toBeLessThan(
        text.indexOf('ci:deploy-stack'),
      );
    }
  });

  it('pins promotion inputs and verifies the concrete live deployment boundaries', async () => {
    const entry = await readFile(path.join(root, '.github/workflows/ci-cd.yml'), 'utf8');
    const promotion = await readFile(
      path.join(root, '.github/workflows/promote-production.yml'),
      'utf8',
    );
    expect(entry.match(/permissions: \{ contents: read, id-token: write \}/g)).toHaveLength(7);
    expect(promotion).toContain('environments/test/releases/${{ inputs.release_id }}.json');
    expect(promotion).toContain('.turbo/ci/source.json');

    const recognition = await readFile(
      path.join(root, '.github/workflows/deploy-recognition.yml'),
      'utf8',
    );
    expect(recognition).toContain('routeKey:"GET /api/recognition/source"');
    expect(recognition).toContain('docker pull "$source_uri"');
    expect(recognition).not.toContain('put-image');

    const gateway = await readFile(path.join(root, '.github/workflows/deploy-gateway.yml'), 'utf8');
    expect(gateway).toContain('Access-Control-Request-Method: GET');
    expect(gateway).toContain('Origin: $origin');

    const web = await readFile(path.join(root, '.github/workflows/deploy-web.yml'), 'utf8');
    expect(web).toContain('*.css) content_type=text/css');
    expect(web).toContain('*.js|*.mjs) content_type=text/javascript');
    expect(web).toContain('head-object --bucket "$bucket"');
    expect(web).toContain('served-module.mjs');
    expect(web).toContain('served-style.css');
  });
});

describe('promotion content selection', () => {
  it('selects changed images and files at the same Git revision while ignoring environment locations', () => {
    let source = emptyDeploymentRecord('test');
    let target = emptyDeploymentRecord('production');
    for (const unit of deploymentUnits) {
      const common = verifiedComponent(`keeper-test-${unit}`);
      let artifact = common.artifact;
      let deployedArtifact = common.artifact;
      if (unit === 'recognition' || unit === 'catalog-ingestion') {
        artifact = {
          kind: 'image',
          values: {
            digest: 'sha256:image-A',
            imageUri: 'test/repo@sha256:image-A',
            version: 'test-tag',
          },
        };
        deployedArtifact = {
          kind: 'image',
          values: {
            digest: 'sha256:image-A',
            imageUri: 'production/repo@sha256:image-A',
            version: 'prod-tag',
          },
        };
      } else if (unit === 'web') {
        artifact = {
          kind: 'files',
          values: {
            bucket: 'test',
            files: JSON.stringify({
              'index.html': { sha256: 'index-A', version: 'test-version' },
              'config.json': { sha256: 'test-settings', version: 'test-settings-version' },
            }),
          },
        };
        deployedArtifact = {
          kind: 'files',
          values: {
            bucket: 'production',
            files: JSON.stringify({
              'config.json': {
                sha256: 'production-settings',
                version: 'production-settings-version',
              },
              'index.html': { sha256: 'index-A', version: 'production-version' },
            }),
          },
        };
      } else if (unit === 'catalog-serving' || unit === 'usercards') {
        artifact = {
          kind: 'files',
          values: {
            sha256: 'zip-A',
            bucket: 'test',
            key: 'test-key',
            objectVersion: 'test-version',
            manifestSha256: 'test-manifest',
          },
        };
        deployedArtifact = {
          kind: 'files',
          values: {
            sha256: 'zip-A',
            bucket: 'production',
            key: 'production-key',
            objectVersion: 'production-version',
            manifestSha256: 'production-manifest',
          },
        };
      }
      source = recordVerifiedComponent(source, unit, { ...common, artifact });
      target = recordVerifiedComponent(target, unit, { ...common, artifact: deployedArtifact });
    }
    const firstRelease = finalizeDeploymentRecord(source, revision, '2026-10-03T00:00:00Z');
    const configuration = Object.fromEntries(deploymentUnits.map((unit) => [unit, 'c'.repeat(64)]));
    expect(planPromotion(firstRelease, target, revision, configuration).candidates).toEqual([]);
    for (const unit of [
      'recognition',
      'catalog-ingestion',
      'catalog-serving',
      'usercards',
      'web',
    ] as const) {
      const component = firstRelease.components[unit]!;
      const values = { ...component.artifact.values };
      if (component.artifact.kind === 'image') values['digest'] = 'sha256:image-B';
      else if (unit === 'web')
        values['files'] = JSON.stringify({ 'index.html': { sha256: 'index-B', version: 'new' } });
      else values['sha256'] = 'zip-B';
      const changed = recordVerifiedComponent(firstRelease, unit, {
        ...component,
        artifact: { ...component.artifact, values },
      });
      const secondRelease = finalizeDeploymentRecord(changed, revision, '2026-10-03T01:00:00Z');
      expect(secondRelease.releaseId).not.toBe(firstRelease.releaseId);
      expect(secondRelease.revision).toBe(firstRelease.revision);
      expect(planPromotion(secondRelease, target, revision, configuration).candidates).toEqual([
        unit,
      ]);
    }
  });
});

describe('deployment evidence', () => {
  it('gives repeated finalization the same identity and configuration redeployments a separate release', () => {
    const verified = recordVerifiedComponent(
      emptyDeploymentRecord('test'),
      'gateway',
      verifiedComponent('keeper-test-gateway'),
    );
    const first = finalizeDeploymentRecord(verified, revision, '2026-10-03T00:00:00Z');
    const retry = finalizeDeploymentRecord(verified, revision, '2026-10-03T01:00:00Z');
    expect(retry.releaseId).toBe(first.releaseId);
    expect(finalizeDeploymentRecord(first, revision, '2026-10-03T02:00:00Z').releaseId).toBe(
      first.releaseId,
    );
    const configured = recordVerifiedComponent(first, 'gateway', {
      ...verifiedComponent('keeper-test-gateway'),
      configurationSha256: 'd'.repeat(64),
    });
    const next = finalizeDeploymentRecord(configured, revision, '2026-10-03T03:00:00Z');
    expect(next.releaseId).not.toBe(first.releaseId);
    const reverified = recordVerifiedComponent(first, 'gateway', {
      ...verifiedComponent('keeper-test-gateway'),
      evidenceUri: 's3://state/another-run/evidence.txt',
    });
    expect(
      finalizeDeploymentRecord(reverified, revision, '2026-10-03T04:00:00Z').releaseId,
    ).not.toBe(first.releaseId);
  });

  it('advances the environment baseline only when finalized and retains the rollback identity', () => {
    const initial = emptyDeploymentRecord('test');
    const first = recordVerifiedComponent(
      initial,
      'gateway',
      verifiedComponent('keeper-test-gateway'),
    );
    expect(first.revision).toBe('0'.repeat(40));
    expect(first.components.gateway?.previousRestorableVersion).toBeNull();

    const second = recordVerifiedComponent(first, 'gateway', {
      ...verifiedComponent('keeper-test-gateway'),
      sourceRevision: '2'.repeat(40),
      templateSha256: 'd'.repeat(64),
    });
    expect(second.components.gateway?.previousRestorableVersion?.sourceRevision).toBe(revision);
    expect(second.revision).toBe('0'.repeat(40));

    const final = finalizeDeploymentRecord(second, '2'.repeat(40), '2026-10-03T00:00:00.000Z');
    expect(final.revision).toBe('2'.repeat(40));
  });

  it.each(deploymentUnits)(
    'preserves the previous distinct %s deployment after no-op retries',
    (unit) => {
      const component = verifiedComponent(`keeper-test-${unit}`);
      const first = recordVerifiedComponent(emptyDeploymentRecord('test'), unit, component);
      const secondComponent = {
        ...component,
        sourceRevision: '2'.repeat(40),
        artifact: { kind: 'image' as const, values: { digest: 'artifact-B' } },
      };
      const second = recordVerifiedComponent(first, unit, secondComponent);
      const rollback = second.components[unit]?.previousRestorableVersion;
      expect(rollback?.artifact).toEqual(component.artifact);
      const retry = recordVerifiedComponent(second, unit, {
        ...secondComponent,
        sourceRevision: '3'.repeat(40),
        evidenceUri: 's3://state/new-verification.txt',
        verification: { ...component.verification, checkedAt: '2026-10-03T03:00:00Z' },
      });
      expect(retry.components[unit]?.previousRestorableVersion).toEqual(rollback);
      expect(retry.components[unit]?.verification.checkedAt).toBe('2026-10-03T03:00:00Z');
      expect(
        recordVerifiedComponent(first, unit, component).components[unit]?.previousRestorableVersion,
      ).toBeNull();
      for (const changed of [
        { templateSha256: 'changed-template' },
        { configurationSha256: 'changed-configuration' },
        { artifact: { kind: 'image' as const, values: { digest: 'artifact-C' } } },
      ]) {
        const next = recordVerifiedComponent(retry, unit, { ...secondComponent, ...changed });
        expect(next.components[unit]?.previousRestorableVersion?.artifact).toEqual(
          secondComponent.artifact,
        );
      }
    },
  );

  it('rejects a candidate older than a partially deployed component', async () => {
    const partial = recordVerifiedComponent(emptyDeploymentRecord('test'), 'web', {
      ...verifiedComponent('keeper-test-web'),
      sourceRevision: '2'.repeat(40),
    });
    await expect(
      assertFreshRevision(partial, revision, async (deployed, candidate) => {
        return deployed === candidate;
      }),
    ).rejects.toThrow(`Refusing stale revision ${revision}`);
  });
});

describe('change-set safety', () => {
  it('builds parameters from the desired template and omits removed parameters', () => {
    expect(
      buildParameterArguments(
        {
          Parameters: {
            Existing: {},
            NewRequired: {},
            NewDefaulted: { Default: 'default' },
          },
        },
        { NewRequired: 'configured' },
        new Set(['Existing', 'Removed']),
      ),
    ).toEqual([
      'ParameterKey=Existing,UsePreviousValue=true',
      'ParameterKey=NewRequired,ParameterValue=configured',
    ]);
  });

  it('fails when desired required parameters or supplied template parameters do not match', () => {
    expect(() => buildParameterArguments({ Parameters: { Required: {} } }, {}, new Set())).toThrow(
      /Required parameter Required/,
    );
    expect(() =>
      buildParameterArguments({ Parameters: {} }, { Removed: 'value' }, new Set(['Removed'])),
    ).toThrow(/not present in the desired template: Removed/);
  });

  it('protects actual retained resource types and conditional replacements', () => {
    const template = {
      Resources: {
        ArtifactsBucket: {
          Type: 'AWS::S3::Bucket',
          DeletionPolicy: 'RetainExceptOnCreate',
          UpdateReplacePolicy: 'Retain',
        },
        CatalogWriterSecret: { Type: 'AWS::SecretsManager::Secret' },
        DatabaseCluster: { Type: 'AWS::RDS::DBCluster', DeletionPolicy: 'Snapshot' },
      },
    };
    expect(
      isDestructiveProtectedChange(
        {
          Action: 'Modify',
          LogicalResourceId: 'ArtifactsBucket',
          ResourceType: 'AWS::S3::Bucket',
          Replacement: 'True',
        },
        template,
      ),
    ).toBe(true);
    expect(
      isDestructiveProtectedChange(
        {
          Action: 'Remove',
          LogicalResourceId: 'CatalogWriterSecret',
          ResourceType: 'AWS::SecretsManager::Secret',
        },
        template,
      ),
    ).toBe(true);
    expect(
      isDestructiveProtectedChange(
        {
          Action: 'Modify',
          LogicalResourceId: 'DatabaseCluster',
          ResourceType: 'AWS::RDS::DBCluster',
          Replacement: 'Conditional',
        },
        template,
      ),
    ).toBe(true);
  });
});

function verifiedComponent(
  stackName: string,
): Omit<ComponentDeploymentRecord, 'previousRestorableVersion'> {
  return {
    sourceRevision: revision,
    stackName,
    templateSha256: 'a'.repeat(64),
    configurationSha256: 'b'.repeat(64),
    environmentConfigurationSha256: 'c'.repeat(64),
    templateUri: 's3://state/template.json',
    configurationUri: 's3://state/parameters.json',
    evidenceUri: 's3://state/evidence.txt',
    artifact: { kind: 'none', values: {} },
    inputs: [],
    verification: {
      status: 'passed',
      checkedAt: '2026-10-03T00:00:00.000Z',
      evidence: ['verified'],
    },
  };
}
