import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  emptyDeploymentRecord,
  finalizeDeploymentRecord,
  recordVerifiedComponent,
  type ComponentDeploymentRecord,
} from '../../scripts/ci/deployment-record.js';
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
