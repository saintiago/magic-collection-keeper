import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Validates the rebuild's CloudFormation templates (docs/operations.md#infrastructure).
 *
 * The two migration-source templates and both synthesized CDK layouts are linted with the cfn-lint
 * version pinned in infra/requirements-lint.txt, provisioned once into the ignored
 * `.infrastructure-python` environment. The check establishes template validity only: configured
 * identity and network boundaries and an applicable change plan are inspected against a deployed
 * environment, and infra/README.md records those steps.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const infraRoot = path.join(root, 'infra');
const environment = path.join(root, '.infrastructure-python');
const requirements = path.join(infraRoot, 'requirements-lint.txt');
const windows = process.platform === 'win32';

const managedPython = path.join(environment, windows ? 'Scripts/python.exe' : 'bin/python');
const managedPip = path.join(environment, windows ? 'Scripts/pip.exe' : 'bin/pip');
const managedLint = path.join(environment, windows ? 'Scripts/cfn-lint.exe' : 'bin/cfn-lint');

const requested = process.env.KEEPER_PYTHON ?? 'python3';

/** Deployment captures under infra/ that are not templates; both are ignored by Git. */
const CAPTURES = new Set(['outputs.json', 'service-outputs.json']);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The cfn-lint release this check runs, read from the committed pin. */
function pinnedVersion(): string {
  const text = existsSync(requirements)
    ? readFileSync(requirements, 'utf8')
    : fail(
        `The pinned infrastructure requirements are missing (${path.relative(root, requirements)}).`,
      );
  const pin = /^cfn-lint==(\S+)$/m.exec(text);
  const version = pin?.[1];
  if (version === undefined) {
    fail(
      `${path.relative(root, requirements)} must pin one cfn-lint release as "cfn-lint==<version>".`,
    );
  }
  return version;
}

/** The templates to validate: migration sources plus synthesized legacy and target layouts. */
function templates(): readonly string[] {
  const files = readdirSync(infraRoot)
    .filter((name) => name.endsWith('.json') && !CAPTURES.has(name))
    .map((name) => path.join('infra', name));
  for (const directory of ['.turbo/cdk-legacy.out', '.turbo/cdk.out']) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) {
      fail(`The synthesized infrastructure directory is missing (${directory}).`);
    }
    files.push(
      ...readdirSync(absolute)
        .filter((name) => name.endsWith('.template.json'))
        .map((name) => path.join(directory, name)),
    );
  }
  files.sort();
  if (files.length === 0) {
    fail('infra/ holds no CloudFormation template to validate.');
  }
  return files;
}

function requireBaselineVersion(executable: string): void {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    fail(
      `Python was not found through "${executable}": ${probe.error.message}. ` +
        'Install Python 3.12 or newer or set KEEPER_PYTHON to its executable.',
    );
  }
  const reported = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
  const version = /Python (\d+)\.(\d+)/.exec(reported);
  if (probe.status !== 0 || version === null) {
    fail(`Could not determine the Python version of "${executable}".`);
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  if (major < 3 || (major === 3 && minor < 12)) {
    fail(`Python 3.12 or newer is required to validate the templates, but found ${reported}.`);
  }
}

/** The cfn-lint release an installed console script reports, or null when it cannot run. */
function installedVersion(executable: string): string | null {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const reported = /(\d+\.\d+\.\d+)/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
  return reported?.[1] ?? null;
}

function installLinter(): void {
  if (!existsSync(managedPython)) {
    console.log('Creating the .infrastructure-python environment for the template check.');
    const created = spawnSync(requested, ['-m', 'venv', environment], { stdio: 'inherit' });
    if (created.status !== 0 || created.error) {
      fail(
        `The infrastructure Python environment could not be created with "${requested}". ` +
          'Install Python 3.12 or newer with venv support, or set KEEPER_PYTHON to its ' +
          'executable.',
      );
    }
  }
  console.log('Installing the pinned CloudFormation linter into .infrastructure-python/.');
  const installed = spawnSync(
    managedPip,
    ['install', '--disable-pip-version-check', '--quiet', '--upgrade', '-r', requirements],
    { stdio: 'inherit' },
  );
  if (installed.status !== 0 || installed.error) {
    fail(
      'The pinned CloudFormation linter could not be installed into .infrastructure-python/. ' +
        'The check needs network access to the Python package index.',
    );
  }
}

function linter(pin: string): string {
  if (installedVersion(managedLint) === pin) return managedLint;
  requireBaselineVersion(requested);
  installLinter();
  if (installedVersion(managedLint) !== pin) {
    fail(`The provisioned cfn-lint release is not the pinned ${pin}.`);
  }
  return managedLint;
}

const pin = pinnedVersion();
const files = templates();
const executable = linter(pin);

const result = spawnSync(executable, files, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
if (result.error) {
  fail(`The template check could not start: ${result.error.message}`);
}
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.status !== 0) {
  fail(
    `cfn-lint ${pin} reported findings for ${files.join(', ')}. ` +
      'Repair the template or record why the finding does not apply before deploying it.',
  );
}
console.log(`Validated ${files.join(', ')} with cfn-lint ${pin}.`);
