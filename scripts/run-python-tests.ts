import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the retained recognition regressions (src/recognition/python/tests).
 *
 * The preserved engine needs NumPy, Pillow and OpenCV for some of its regressions. The runner
 * provisions those pinned requirements once into the ignored `.recognition-python` environment so
 * that a prepared checkout reproduces the baseline suite. Where they cannot be installed, the
 * affected modules skip themselves and report that dependency instead of failing the run.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recognitionRoot = path.join(root, 'src', 'recognition', 'python');
const environment = path.join(root, '.recognition-python');
const requirements = path.join(recognitionRoot, 'requirements-tests.txt');
const windows = process.platform === 'win32';

const managedPython = path.join(environment, windows ? 'Scripts/python.exe' : 'bin/python');
const managedPip = path.join(environment, windows ? 'Scripts/pip.exe' : 'bin/pip');

const requested = process.env.KEEPER_PYTHON ?? 'python3';

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

function provision(): string | null {
  console.log('Installing the pinned recognition test requirements into .recognition-python/.');
  const created = spawnSync(requested, ['-m', 'venv', environment], { stdio: 'inherit' });
  if (created.status !== 0 || created.error) {
    console.warn('The recognition Python environment could not be created.');
    return null;
  }
  const installed = spawnSync(
    managedPip,
    ['install', '--disable-pip-version-check', '--quiet', '-r', requirements],
    { stdio: 'inherit' },
  );
  if (installed.status !== 0 || installed.error) {
    console.warn('The pinned recognition test requirements could not be installed.');
    return null;
  }
  return engineRequirements(managedPython) ? managedPython : null;
}

function interpreter(): string {
  requireBaselineVersion(requested);
  if (process.env.KEEPER_PYTHON) {
    if (!engineRequirements(requested)) warnUnavailable();
    return requested;
  }
  if (engineRequirements(managedPython)) return managedPython;
  if (engineRequirements(requested)) return requested;
  const provisioned = provision();
  if (provisioned) return provisioned;
  warnUnavailable();
  return requested;
}

function warnUnavailable(): void {
  console.warn(
    'The recognition engine requirements (numpy, Pillow, OpenCV) are unavailable, so the modules ' +
      `that need them report a skip. Install ${path.relative(root, requirements)} or set ` +
      'KEEPER_PYTHON to an interpreter that has them to run every regression.',
  );
}

const executable = interpreter();
const result = spawnSync(executable, ['-m', 'unittest', 'discover', '-s', 'tests'], {
  cwd: recognitionRoot,
  stdio: 'inherit',
});

if (result.error) {
  fail(`Recognition tests could not start: ${result.error.message}`);
}

process.exitCode = result.status ?? 1;
