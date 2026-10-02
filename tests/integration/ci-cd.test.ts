import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertFreshRevision,
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
      changedPaths: ['docs/ci-cd.md', 'tests/integration/ci-cd.test.ts'],
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
      baseRevision: '0'.repeat(40),
      sourceRevision: revision,
      changedPaths: ['src/ui/removed-production-module.ts'],
      mapping,
      productionInputs: { web: [] },
      deployedRecord: withFormerWebInput,
    });
    expect(plan.candidates).toEqual(['web']);
    expect(plan.reasons.web).toEqual(['src/ui/removed-production-module.ts']);
  });

  it('maps Recognition preparation and packaging helpers to every artifact they affect', async () => {
    const mapping = await readStackInputMapping(mappingFile);
    const productionInputs = await collectProductionInputs(root);
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
      baseRevision: '0'.repeat(40),
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
    }
  });

  it('pins promotion inputs and verifies the concrete live deployment boundaries', async () => {
    const entry = await readFile(path.join(root, '.github/workflows/ci-cd.yml'), 'utf8');
    const promotion = await readFile(
      path.join(root, '.github/workflows/promote-production.yml'),
      'utf8',
    );
    expect(entry.match(/permissions: \{ contents: read, id-token: write \}/g)).toHaveLength(7);
    expect(promotion).toContain('environments/test/releases/${{ inputs.revision }}.json');
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
    expect(web).toContain('*.js|*.mjs) content_type=text/javascript');
    expect(web).toContain('head-object --bucket "$bucket"');
    expect(web).toContain('served-module.mjs');
  });
});

describe('deployment evidence', () => {
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
