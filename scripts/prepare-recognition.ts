/**
 * Preparation of the retained recognition assets (docs/operations.md#recognition-packaging,
 * docs/recognition.md#engines-and-assets).
 *
 * Preparation is a build-time step and stays out of the checks: it fetches the pinned public model
 * and catalog bytes through the retained preparation scripts, converts the pinned original text
 * weights to ONNX, exports the browser assets, assembles the corresponding-source download, and
 * copies the browser ONNX runtime from the locked `onnxruntime-web` dependency. It changes no
 * policy, threshold or preprocessing: the two Python environments below are build inputs only, and
 * the prepared bytes are verified against the committed manifests by
 * `npm run package:recognition` (scripts/package-recognition.ts).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './packaging-support.js';
import {
  preparedRecognitionRoot,
  readBrowserRuntimePin,
  verifyPreparedRecognition,
  type RecognitionRuntimePin,
  type VerifiedRecognition,
} from './recognition-manifests.js';

/** Directory the browser ONNX runtime is copied into, beside the preserved modules. */
function browserRuntimeDirectory(root: string): string {
  return path.join(root, 'src', 'recognition', 'browser', 'vendor', 'ort');
}

/**
 * Verifies that the installed, locked ONNX Runtime Web dependency still provides exactly the bytes
 * `src/recognition/browser-runtime.json` pins. A dependency update therefore has to update the pin
 * deliberately instead of silently changing what the preserved modules load.
 */
export async function verifyBrowserRuntimePin(
  root: string = repoRoot,
): Promise<RecognitionRuntimePin> {
  const pin = await readBrowserRuntimePin(root);
  const declared = readDeclaredVersion(root, pin.package);
  if (declared !== pin.version) {
    throw new Error(
      `package.json declares ${pin.package} ${declared ?? '(nothing)'} but the browser runtime pin ` +
        `names ${pin.version}; update src/recognition/browser-runtime.json with the reviewed files.`,
    );
  }
  const dist = path.join(root, 'node_modules', pin.package, 'dist');
  const files: Record<string, string> = { [pin.runtime.file]: pin.runtime.sha256, ...pin.modules };
  for (const [name, digest] of Object.entries(files)) {
    const found = sha256(await readInstalledFile(path.join(dist, name), pin));
    if (found !== digest) {
      throw new Error(
        `${pin.package}@${pin.version} ${name} does not match src/recognition/browser-runtime.json ` +
          `(found ${found}); run \`npm ci\` or update the pin deliberately.`,
      );
    }
  }
  return pin;
}

/** Copies the verified browser ONNX runtime beside the preserved modules, as they resolve it. */
export async function prepareBrowserRuntime(root: string = repoRoot): Promise<readonly string[]> {
  const pin = await verifyBrowserRuntimePin(root);
  const dist = path.join(root, 'node_modules', pin.package, 'dist');
  const vendor = browserRuntimeDirectory(root);
  await rm(vendor, { recursive: true, force: true });
  await mkdir(vendor, { recursive: true });
  const files: Record<string, string> = { [pin.runtime.file]: pin.runtime.sha256, ...pin.modules };
  for (const name of Object.keys(files).sort()) {
    await writeFile(path.join(vendor, name), await readFile(path.join(dist, name)));
  }
  // The preserved modules verify this pinned runtime description before they execute the model.
  await writeFile(
    path.join(vendor, 'runtime.json'),
    `${JSON.stringify(
      {
        version: pin.version,
        file: pin.runtime.file,
        bytes: pin.runtime.bytes,
        sha256: pin.runtime.sha256,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return Object.keys(files).sort();
}

interface PreparationStep {
  readonly script: string;
  readonly what: string;
  /** True when the retained converter environment, not the engine environment, runs the script. */
  readonly converter: boolean;
}

/** The retained preparation scripts, in the order their outputs depend on each other. */
const preparationSteps: readonly PreparationStep[] = [
  {
    script: 'scripts/prepare.py',
    what: 'fetch the pinned public models, catalog, title names and artwork fixtures',
    converter: false,
  },
  {
    script: 'scripts/convert_ocr.py',
    what: 'convert the pinned original text weights to ONNX',
    converter: true,
  },
  {
    script: 'scripts/browser_assets.py',
    what: 'export the browser catalog and model bytes',
    converter: false,
  },
  {
    script: 'scripts/source_bundle.py',
    what: 'assemble the corresponding-source download',
    converter: false,
  },
];

/**
 * Runs the retained preparation scripts with the interpreters the deployment prepared. The scripts
 * keep their own network and digest handling; a failure here is a preparation failure, never a
 * silently different engine.
 */
export function runRetainedPreparation(
  root: string,
  python: string,
  converterPython: string = python,
): void {
  for (const step of preparationSteps) {
    const interpreter = step.converter ? converterPython : python;
    try {
      execFileSync(resolveInterpreter(root, interpreter), [step.script], {
        cwd: preparedRecognitionRoot(root),
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(
        `The retained preparation step ${step.script} (${step.what}) failed with "${interpreter}": ` +
          `${error instanceof Error ? error.message.split('\n')[0] : String(error)}. ` +
          'Preparation needs Python 3.12 with the pinned build requirements and access to the ' +
          'public model/catalog sources (docs/operations.md#recognition-packaging):\n' +
          '  python3 -m venv .recognition-build/runtime\n' +
          '  .recognition-build/runtime/bin/pip install -r src/recognition/python/requirements-visual.txt\n' +
          '  python3 -m venv .recognition-build/converter\n' +
          '  .recognition-build/converter/bin/pip install -r src/recognition/python/requirements-converter.txt\n' +
          '  npm run prepare:recognition -- --python .recognition-build/runtime/bin/python ' +
          '--converter-python .recognition-build/converter/bin/python',
        { cause: error },
      );
    }
  }
}

/** An interpreter named by path resolves against the checkout, not the prepared package. */
function resolveInterpreter(root: string, interpreter: string): string {
  return interpreter.includes('/') || interpreter.includes(path.sep)
    ? path.resolve(root, interpreter)
    : interpreter;
}

/** Prepares both the browser runtime and the retained engine assets of this checkout. */
export async function prepareRecognition(
  root: string,
  python: string,
  converterPython: string = python,
): Promise<VerifiedRecognition> {
  const runtime = await prepareBrowserRuntime(root);
  console.log(`Prepared the pinned browser ONNX runtime: ${runtime.join(', ')}.`);
  runRetainedPreparation(root, python, converterPython);
  const verified = await verifyPreparedRecognition(root);
  console.log(`Verified the prepared engine: ${Object.keys(verified.engine.models).join(', ')}.`);
  return verified;
}

function readDeclaredVersion(root: string, name: string): string | null {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  return manifest.devDependencies?.[name] ?? manifest.dependencies?.[name] ?? null;
}

async function readInstalledFile(file: string, pin: RecognitionRuntimePin): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch {
    throw new Error(
      `The locked ${pin.package} dependency is not installed at node_modules/${pin.package}; ` +
        'run `npm ci` before preparing the recognition assets.',
    );
  }
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

interface CommandLine {
  readonly python: string;
  readonly converterPython: string | null;
}

function readCommandLine(argv: readonly string[]): CommandLine {
  const command: { python?: string; converterPython?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`The ${flag ?? 'prepare'} flag requires a value.`);
    }
    switch (flag) {
      case '--python':
        command.python = value;
        break;
      case '--converter-python':
        command.converterPython = value;
        break;
      default:
        throw new Error(`Unsupported preparation flag ${flag ?? ''}.`);
    }
    index += 1;
  }
  return {
    python: command.python ?? process.env['KEEPER_PYTHON'] ?? 'python3',
    converterPython: command.converterPython ?? null,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = readCommandLine(process.argv.slice(2));
  const verified = await prepareRecognition(
    repoRoot,
    command.python,
    command.converterPython ?? command.python,
  );
  console.log(
    `Prepared and verified the retained recognition assets: catalog ${
      verified.engine.catalog.key
    }@${verified.engine.catalog.version} with ${verified.engine.catalog.rows} rows, ${
      verified.browser.assets.length
    } browser assets and a ${verified.source.bytes}-byte corresponding-source download. ` +
      'Package them with `npm run package` and `npm run package:recognition`.',
  );
}
