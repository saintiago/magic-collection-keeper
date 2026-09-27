import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the retained recognition regressions (src/recognition/python/tests).
 *
 * The preserved engine needs NumPy, Pillow and OpenCV, and the complete retained suite must run:
 * docs/testing.md forbids skipping regressions to obtain a passing run. The runner provisions the
 * pinned requirements once into the ignored `.recognition-python` environment and fails with an
 * actionable error when those dependencies are missing or cannot be installed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recognitionRoot = path.join(root, 'src', 'recognition', 'python');
const environment = path.join(root, '.recognition-python');
const requirements = path.join(recognitionRoot, 'requirements-tests.txt');
const windows = process.platform === 'win32';

const managedPython = path.join(environment, windows ? 'Scripts/python.exe' : 'bin/python');
const managedPip = path.join(environment, windows ? 'Scripts/pip.exe' : 'bin/pip');

const requested = process.env.KEEPER_PYTHON ?? 'python3';

/** The retained baseline executes 27 regressions; a smaller run has lost coverage. */
const expectedRegressions = 27;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireBaselineVersion(executable: string): void {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  const reported = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
  if (probe.error) {
    fail(
      `Python was not found through "${executable}": ${probe.error.message}. ` +
        'Install Python 3.12 or newer or set KEEPER_PYTHON to its executable.',
    );
  }
  const version = /Python (\d+)\.(\d+)/.exec(reported);
  if (probe.status !== 0 || version === null) {
    fail(`Could not determine the Python version of "${executable}".`);
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  if (major < 3 || (major === 3 && minor < 12)) {
    fail(`Python 3.12 or newer is required for recognition tests, but found ${reported}.`);
  }
}

function engineRequirements(executable: string): boolean {
  return spawnSync(executable, ['-c', 'import numpy, PIL, cv2'], { stdio: 'ignore' }).status === 0;
}

function missingRequirementsHint(): string {
  return (
    `The recognition regressions require NumPy, Pillow and OpenCV (${path.relative(root, requirements)}). ` +
    'Install them into KEEPER_PYTHON, or leave KEEPER_PYTHON unset so the runner can provision ' +
    'the pinned versions into .recognition-python/.'
  );
}

function provision(): string {
  console.log('Installing the pinned recognition test requirements into .recognition-python/.');
  const created = spawnSync(requested, ['-m', 'venv', environment], { stdio: 'inherit' });
  if (created.status !== 0 || created.error) {
    fail(
      `The recognition Python environment could not be created with "${requested}". ` +
        'Install Python 3.12 or newer with venv support, or set KEEPER_PYTHON to an interpreter ' +
        'that already has the requirements.\n' +
        missingRequirementsHint(),
    );
  }
  const installed = spawnSync(
    managedPip,
    ['install', '--disable-pip-version-check', '--quiet', '-r', requirements],
    { stdio: 'inherit' },
  );
  if (installed.status !== 0 || installed.error) {
    fail(
      'The pinned recognition test requirements could not be installed into ' +
        `.recognition-python/.\n${missingRequirementsHint()}`,
    );
  }
  if (!engineRequirements(managedPython)) {
    fail(
      `The provisioned .recognition-python environment is still incomplete.\n${missingRequirementsHint()}`,
    );
  }
  return managedPython;
}

function interpreter(): string {
  requireBaselineVersion(requested);
  if (process.env.KEEPER_PYTHON) {
    if (!engineRequirements(requested)) {
      fail(
        `KEEPER_PYTHON ("${requested}") cannot import numpy, PIL and cv2.\n${missingRequirementsHint()}`,
      );
    }
    return requested;
  }
  if (engineRequirements(managedPython)) return managedPython;
  return provision();
}

const executable = interpreter();
const result = spawnSync(executable, ['-m', 'unittest', 'discover', '-s', 'tests'], {
  cwd: recognitionRoot,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error) {
  fail(`Recognition tests could not start: ${result.error.message}`);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const ran = /Ran (\d+) tests?/.exec(output);
if (ran === null || Number(ran[1]) < expectedRegressions) {
  fail(
    `Only ${ran?.[1] ?? 'no'} of the ${expectedRegressions} retained recognition regressions ran. ` +
      'Restoring or repairing a preserved module must not remove its regressions.',
  );
}

const skipped = /skipped=(\d+)/.exec(output);
if (skipped !== null && Number(skipped[1]) > 0) {
  fail(
    `${skipped[1]} retained recognition regressions were skipped. docs/testing.md requires the ` +
      'complete retained suite to run.',
  );
}
