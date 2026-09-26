import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recognitionRoot = path.join(root, 'src', 'recognition');
const executable = process.env.KEEPER_PYTHON ?? 'python3';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' });
const reported = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
const version = /Python (\d+)\.(\d+)/.exec(reported);

if (probe.error) {
  fail(
    `Python was not found through "${executable}": ${probe.error.message}. ` +
      'Install Python 3.12 or newer or set KEEPER_PYTHON to its executable.',
  );
}

if (probe.status !== 0 || version === null) {
  fail(`Could not determine the Python version of "${executable}".`);
}

const major = Number(version[1]);
const minor = Number(version[2]);
if (major < 3 || (major === 3 && minor < 12)) {
  fail(`Python 3.12 or newer is required for recognition tests, but found ${reported}.`);
}

const result = spawnSync(executable, ['-m', 'unittest', 'discover', '-s', 'tests'], {
  cwd: recognitionRoot,
  stdio: 'inherit',
});

if (result.error) {
  fail(`Recognition tests could not start: ${result.error.message}`);
}

process.exitCode = result.status ?? 1;
