/**
 * Integration scope: the recognition packaging step of an explicit deployment
 * (docs/operations.md#recognition-packaging, docs/recognition.md#engines-and-assets).
 *
 * The command that assembles the recognition image context runs against a prepared engine package:
 * a synthetic checkout carries the retained component layout with its own pinned manifests, its
 * prepared model/catalog/OCR bytes, the prepared browser assets and a corresponding-source download
 * the retained bundler assembles from that checkout. The pinned browser ONNX runtime is checked
 * against the real locked dependency. Building and pushing the image, live Lambda/model-provider
 * checks and physical-camera acceptance stay separate evidence (docs/testing.md).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageArtifacts } from '../../scripts/package-artifacts.js';
import {
  packageRecognition,
  recognitionArtifactLayout,
  recognitionBaseImage,
  type PackagedRecognition,
} from '../../scripts/package-recognition.js';
import { verifyBrowserRuntimePin } from '../../scripts/prepare-recognition.js';
import { verifyPreparedRecognition } from '../../scripts/recognition-manifests.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const revision = '0123456789abcdef0123456789abcdef01234567';
const python = process.env['KEEPER_PYTHON'] ?? 'python3';

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function write(root: string, file: string, content: string | Uint8Array): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=keeper@example.test',
      '-c',
      'user.name=Keeper Packaging',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

interface PreparedCheckout {
  readonly root: string;
  readonly models: Readonly<Record<string, string>>;
  readonly runtime: { readonly file: string; readonly bytes: number; readonly sha256: string };
  readonly visualAssets: readonly string[];
}

/**
 * A prepared checkout of the retained component layout. The engine sources and their baseline
 * digests, the prepared assets, the pinned manifests, the browser assets and the source download
 * are all internally consistent, so the packaging command runs for real against it.
 */
async function createPreparedCheckout(workspace: string): Promise<PreparedCheckout> {
  const root = path.join(workspace, 'checkout');
  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: 'magic-collection-keeper',
        version: '0.1.0',
        devDependencies: { 'onnxruntime-web': '1.29.0' },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    '.gitignore',
    [
      'src/recognition/python/artifacts/',
      'src/recognition/python/vendor/',
      'src/recognition/browser/vendor/',
      '*.zip',
      '',
    ].join('\n'),
  );

  // The retained engine modules, each pinned by the baseline the packaging step verifies.
  const modules: Readonly<Record<string, string>> = {
    'handler.py': '"""handler fixture"""\n',
    'lambda_entry.py': '"""entry fixture"""\n',
    'composition.py': '"""composition fixture"""\n',
    'adapters/collectorvision.py': '"""adapter fixture"""\n',
    'scripts/smoke.py': '"""smoke fixture"""\n',
  };
  const baselineFiles: Record<string, { source: string; sha256: string }> = {};
  for (const [file, content] of Object.entries(modules)) {
    await write(root, `src/recognition/python/${file}`, content);
    baselineFiles[`src/recognition/python/${file}`] = {
      source: `recognition/${file}`,
      sha256: digest(content),
    };
  }
  await write(
    root,
    'src/recognition/baseline.json',
    `${JSON.stringify(
      { baseline: { revision }, note: 'fixture', files: baselineFiles, adapted: {} },
      null,
      2,
    )}\n`,
  );

  // The pinned upstream CollectorVision checkout, its own clone at the pinned revision.
  const collectorVision = path.join(
    root,
    'src',
    'recognition',
    'python',
    'vendor',
    'CollectorVision',
  );
  await write(collectorVision, 'setup.py', '# pinned upstream fixture\n');
  await write(collectorVision, 'collector_vision/__init__.py', '# pinned upstream fixture\n');
  git(collectorVision, ['init', '-q', '-b', 'main']);
  git(collectorVision, ['add', '-A']);
  git(collectorVision, ['commit', '-q', '-m', 'pinned upstream']);
  const code = git(collectorVision, ['rev-parse', 'HEAD']);

  const weights: Readonly<Record<string, Uint8Array>> = {
    'cornelius.onnx': Buffer.from('pinned geometry weights'),
    'milo.onnx': Buffer.from('pinned embedding weights'),
  };
  const embedding = `collectorvision@${code}:milo-1.0.0@sha256:${digest(weights['milo.onnx'] ?? Buffer.alloc(0))}`;
  const artifactManifest = {
    code,
    models: {
      'cornelius.onnx': digest(weights['cornelius.onnx'] ?? Buffer.alloc(0)),
      'milo.onnx': digest(weights['milo.onnx'] ?? Buffer.alloc(0)),
    },
    catalog: { key: 'milo1/scryfall/mtg', version: 27, rows: 4, embedding },
  };
  await write(
    root,
    'src/recognition/python/artifact-manifest.json',
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
  );
  await write(
    root,
    'src/recognition/python/artifacts/artifact-manifest.json',
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
  );
  for (const [name, content] of Object.entries(weights)) {
    await write(root, `src/recognition/python/artifacts/weights/${name}`, content);
  }

  // The prepared catalog snapshot version 27 the engines search offline.
  const embeddings = Buffer.from('pinned catalog embeddings');
  const catalogRecords = [
    {
      id: 'printing-1',
      identifiers: { scryfall_oracle: 'oracle-1' },
      name: 'Alpha Bolt',
      finishes: ['nonfoil', 'foil'],
      metadata: { set: 'tst', collector_number: '1', lang: 'en' },
    },
    {
      id: 'printing-2',
      identifiers: { scryfall_oracle: 'oracle-2' },
      name: 'Beta Ring',
      finishes: ['nonfoil'],
      metadata: { set: 'tst', collector_number: '2', lang: 'de' },
    },
    {
      id: 'printing-3',
      identifiers: { scryfall_oracle: 'oracle-3' },
      name: 'Gamma Post',
      finishes: ['foil'],
      metadata: { set: 'tst', collector_number: '3', lang: 'en' },
    },
    { id: 'printing-4', identifiers: { scryfall_oracle: 'oracle-4' }, name: 'Delta Mox' },
  ];
  const records = gzipSync(
    Buffer.from(`${catalogRecords.map((record) => JSON.stringify(record)).join('\n')}\n`),
  );
  // The browser export is the compact projection the retained script writes: the same rows in the
  // same order with the fields the browser search uses.
  const browserRecords = gzipSync(
    Buffer.from(
      JSON.stringify(
        catalogRecords.map((record) => ({
          id: record.id,
          oracle_id: record.identifiers.scryfall_oracle,
          name: record.name,
          finishes: record.finishes,
          set: record.metadata?.set ?? null,
          collector_number: record.metadata?.collector_number ?? null,
          lang: record.metadata?.lang ?? null,
        })),
      ),
    ),
  );
  const snapshot =
    'src/recognition/python/artifacts/catalog/catalog-v2/snapshots/milo1--scryfall--mtg/metadata/version-27';
  await write(root, `${snapshot}/embeddings.f16.gz`, embeddings);
  await write(root, `${snapshot}/records.jsonl.gz`, records);
  await write(
    root,
    `${snapshot}/snapshot.json`,
    `${JSON.stringify(
      {
        rows: 4,
        embedding: { model: embedding, dimensions: 128 },
        assets: {
          embeddings: { filename: 'embeddings.f16.gz', sha256: digest(embeddings) },
          records: { filename: 'records.jsonl.gz', sha256: digest(records) },
        },
      },
      null,
      2,
    )}\n`,
  );
  // The committed catalog pin and the feed the preparation caches for offline loading.
  const feed = Buffer.from(
    `${JSON.stringify({ checked_at: '2026-09-08T12:11:38Z', families: { milo1: {} } }, null, 2)}\n`,
  );
  await write(root, 'src/recognition/python/catalog-feed.json', feed);
  await write(root, 'src/recognition/python/artifacts/catalog/catalog-v2/feed.json', feed);

  // The pinned original text weights and the converted ONNX files the runtime loads.
  const origins: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    PP_OCRv5_mobile_det: {
      'inference.json': 'detector graph',
      'inference.pdiparams': 'detector params',
    },
    latin_PP_OCRv5_mobile_rec: { 'inference.json': 'recognizer graph' },
  };
  const ocrModels: Record<string, Record<string, string>> = {};
  for (const [model, files] of Object.entries(origins)) {
    const verified: Record<string, string> = {};
    ocrModels[model] = verified;
    for (const [name, content] of Object.entries(files)) {
      await write(root, `src/recognition/python/artifacts/ocr-models/${model}/${name}`, content);
      verified[name] = digest(content);
    }
  }
  await write(
    root,
    'src/recognition/python/ocr-models.json',
    `${JSON.stringify(ocrModels, null, 2)}\n`,
  );
  await write(
    root,
    'src/recognition/python/artifacts/ocr-models.json',
    `${JSON.stringify(ocrModels, null, 2)}\n`,
  );
  const converted: Readonly<Record<string, Uint8Array>> = {
    'det.onnx': Buffer.from('converted detector'),
    'rec.onnx': Buffer.from('converted recognizer'),
    'latin.txt': Buffer.from('a\nb\n'),
  };
  for (const [name, content] of Object.entries(converted)) {
    await write(root, `src/recognition/python/artifacts/ocr-onnx/${name}`, content);
  }
  await write(
    root,
    'src/recognition/python/artifacts/ocr-onnx.json',
    `${JSON.stringify(
      {
        original: ocrModels,
        converter: 'paddle2onnx-2.1.0',
        opset: 17,
        files: Object.fromEntries(
          Object.entries(converted).map(([name, content]) => [name, digest(content)]),
        ),
      },
      null,
      2,
    )}\n`,
  );

  // The pinned public title/printing name snapshot.
  const titleNames = Buffer.from('pinned title names');
  const nameCatalog = {
    url: 'https://example.test/names.json.gz',
    sha256: digest(titleNames),
    identities: 1,
  };
  await write(root, 'src/recognition/python/artifacts/title-names.json.gz', titleNames);
  await write(
    root,
    'src/recognition/python/name-catalog.json',
    `${JSON.stringify(nameCatalog, null, 2)}\n`,
  );
  await write(
    root,
    'src/recognition/python/artifacts/name-catalog.json',
    `${JSON.stringify(nameCatalog, null, 2)}\n`,
  );

  // The public-art frames the packaged smoke regression reads.
  for (const name of ['public-card-frame.jpg', 'public-bolt-frame.jpg', 'public-ring-frame.jpg']) {
    await write(root, `src/recognition/python/artifacts/${name}`, `frame ${name}`);
  }

  // Licence, notices and the runtime requirements the image installs.
  await write(root, 'src/recognition/python/LICENSE', 'AGPL-3.0-only fixture\n');
  await write(
    root,
    'src/recognition/python/notices/CollectorVision-AGPL-3.0.txt',
    'upstream notice fixture\n',
  );
  await write(root, 'src/recognition/python/requirements-linux.txt', 'numpy==2.3.5\n');
  // The retained bundler assembles the corresponding-source download for this checkout.
  await cp(
    path.join(repoRoot, 'src/recognition/python/scripts/source_bundle.py'),
    path.join(root, 'src/recognition/python/scripts/source_bundle.py'),
  );

  // The browser catalog/model assets the preserved modules verify at load, with their manifest.
  const visual: Readonly<Record<string, Uint8Array>> = {
    cornelius: weights['cornelius.onnx'] ?? Buffer.alloc(0),
    milo: weights['milo.onnx'] ?? Buffer.alloc(0),
    embeddings,
    records: browserRecords,
  };
  const visualAssets: Record<string, { file: string; sha256: string; bytes: number }> = {};
  const visualFiles: string[] = [];
  for (const [name, content] of Object.entries(visual)) {
    const sha = digest(content);
    const file = `${sha}.${name === 'embeddings' || name === 'records' ? 'gz' : 'onnx'}`;
    await write(root, `src/recognition/browser/vendor/visual/${file}`, content);
    visualAssets[name] = { file, sha256: sha, bytes: content.byteLength };
    visualFiles.push(`browser/vendor/visual/${file}`);
  }
  await write(
    root,
    'src/recognition/browser/vendor/visual/manifest.json',
    `${JSON.stringify(
      { schema: 1, upstream: artifactManifest, rows: 4, dims: 128, assets: visualAssets },
      null,
      2,
    )}\n`,
  );

  // The pinned browser ONNX runtime, as the preparation step copies it from the dependency.
  const runtime = Buffer.from('pinned wasm runtime');
  const modules2: Readonly<Record<string, Uint8Array>> = {
    'ort.wasm.min.mjs': Buffer.from('pinned runtime module'),
    'ort-wasm-simd-threaded.mjs': Buffer.from('pinned runtime worker'),
  };
  await write(
    root,
    'src/recognition/browser-runtime.json',
    `${JSON.stringify(
      {
        schema: 1,
        package: 'onnxruntime-web',
        version: '1.29.0',
        runtime: {
          file: 'ort-wasm-simd-threaded.wasm',
          bytes: runtime.byteLength,
          sha256: digest(runtime),
        },
        modules: Object.fromEntries(
          Object.entries(modules2).map(([name, content]) => [name, digest(content)]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  await write(root, 'src/recognition/browser/vendor/ort/ort-wasm-simd-threaded.wasm', runtime);
  for (const [name, content] of Object.entries(modules2)) {
    await write(root, `src/recognition/browser/vendor/ort/${name}`, content);
    visualFiles.push(`browser/vendor/ort/${name}`);
  }
  visualFiles.push('browser/vendor/ort/ort-wasm-simd-threaded.wasm');
  await write(
    root,
    'src/recognition/browser/vendor/ort/runtime.json',
    `${JSON.stringify(
      {
        version: '1.29.0',
        file: 'ort-wasm-simd-threaded.wasm',
        bytes: runtime.byteLength,
        sha256: digest(runtime),
      },
      null,
      2,
    )}\n`,
  );

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'prepared recognition fixture']);
  // The retained source bundler is what the release ships, so it assembles the download for real.
  execFileSync(python, ['src/recognition/python/scripts/source_bundle.py'], { cwd: root });

  return {
    root,
    models: artifactManifest.models,
    runtime: {
      file: 'ort-wasm-simd-threaded.wasm',
      bytes: runtime.byteLength,
      sha256: digest(runtime),
    },
    visualAssets: visualFiles.sort(),
  };
}

describe('packaging the retained recognition assets', () => {
  let workspace: string;
  let prepared: PreparedCheckout;
  let packaged: PackagedRecognition;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'keeper-recognition-packaging-'));
    prepared = await createPreparedCheckout(workspace);
    packaged = await packageRecognition({
      outDir: path.join(workspace, 'artifacts'),
      repoRoot: prepared.root,
      revision,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('packages the image context from the verified engine and records every byte', async () => {
    expect(packaged.manifest).toMatchObject({
      schema: 1,
      revision,
      workingTree: 'clean',
      version: `0.1.0-${revision.slice(0, 12)}`,
      baseImage: recognitionBaseImage,
    });
    expect(packaged.manifest.engine.models).toEqual(prepared.models);
    expect(packaged.manifest.engine.catalog).toMatchObject({
      key: 'milo1/scryfall/mtg',
      version: 27,
      rows: 4,
      dimensions: 128,
    });
    expect(packaged.manifest.browser.runtime).toEqual({
      version: '1.29.0',
      ...prepared.runtime,
    });
    expect(packaged.manifest.browser.assets.map((asset) => asset.file)).toEqual(
      prepared.visualAssets,
    );

    const names = packaged.manifest.context.map((file) => file.file);
    for (const file of packaged.manifest.context) {
      const content = await readFile(path.join(packaged.contextDirectory, file.file));
      expect(content.byteLength, file.file).toBe(file.bytes);
      expect(digest(content), file.file).toBe(file.sha256);
    }
    for (const file of [
      'Dockerfile',
      'handler.py',
      'lambda_entry.py',
      'adapters/collectorvision.py',
      'smoke.py',
      'LICENSE',
      'source.zip',
      'notices/CollectorVision-AGPL-3.0.txt',
      'requirements-linux.txt',
      'artifacts/weights/cornelius.onnx',
      'artifacts/ocr-onnx/det.onnx',
      'artifacts/catalog/catalog-v2/feed.json',
      'artifacts/title-names.json.gz',
      'vendor/CollectorVision/setup.py',
    ]) {
      expect(names, file).toContain(file);
    }
    // The context carries the prepared image inputs, not the repository's build material.
    expect(names.some((name) => name.startsWith('tests/'))).toBe(false);
    expect(names.some((name) => name.includes('.git/'))).toBe(false);
    expect(names).not.toContain('scripts/convert_ocr.py');

    const source = await readFile(path.join(packaged.contextDirectory, 'source.zip'));
    expect(packaged.manifest.source).toMatchObject({
      file: 'source.zip',
      bytes: source.byteLength,
      sha256: digest(source),
    });
  });

  it('defines the container the recognition Lambda runs without baking provider settings', async () => {
    const dockerfile = await readFile(path.join(packaged.contextDirectory, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`FROM ${recognitionBaseImage}`);
    expect(dockerfile).toContain('COPY vendor/CollectorVision /tmp/collectorvision');
    expect(dockerfile).toContain('pip install --no-cache-dir --no-deps /tmp/collectorvision');
    expect(dockerfile).toContain('COPY artifacts ./artifacts');
    expect(dockerfile).toContain('COPY LICENSE source.zip ./');
    expect(dockerfile).toContain('ENV RECOGNITION_ARTIFACTS=/var/task/artifacts \\');
    expect(dockerfile).toContain('KEEPER_OCR_ADAPTER=paddle-onnx');
    expect(dockerfile).toContain('ENTRYPOINT ["/lambda-entrypoint.sh"]');
    expect(dockerfile).toContain('CMD ["lambda_entry.handler"]');
    // Model-provider settings and credentials come from the deployed function, never the image.
    expect(dockerfile).not.toContain('KEEPER_TITLE_MODEL');
    expect(dockerfile).not.toContain('KEEPER_IDENTITY_MODEL');
    expect(packaged.manifestPath).toBe(
      path.join(workspace, 'artifacts', recognitionArtifactLayout.manifest),
    );
  });

  it('refuses a prepared model that does not match its pinned digest', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'tampered-model');
    await write(
      tampered,
      'src/recognition/python/artifacts/weights/milo.onnx',
      'substituted weights',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'tampered-model-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/milo\.onnx/);
  });

  it('refuses an upstream checkout whose content differs from its pinned revision', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'tampered-upstream');
    await write(
      tampered,
      'src/recognition/python/vendor/CollectorVision/collector_vision/__init__.py',
      '# pinned upstream fixture\nraise RuntimeError("changed upstream engine")\n',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'tampered-upstream-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/collector_vision\/__init__\.py/);
  });

  it('refuses an additional file in the upstream package', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'extra-upstream');
    await write(
      tampered,
      'src/recognition/python/vendor/CollectorVision/collector_vision/extra.py',
      '"""not part of the pinned revision"""\n',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'extra-upstream-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/collector_vision\/extra\.py/);
  });

  it('packages the pinned upstream tree without its generated build output', async () => {
    const generated = await cloneCheckout(prepared, workspace, 'generated-upstream');
    await write(
      generated,
      'src/recognition/python/vendor/CollectorVision/build/lib/collector_vision/__init__.py',
      '# generated build output\n',
    );
    const packagedGenerated = await packageRecognition({
      outDir: path.join(workspace, 'generated-upstream-artifacts'),
      repoRoot: generated,
      revision,
    });
    const names = packagedGenerated.manifest.context.map((file) => file.file);
    expect(names).toContain('vendor/CollectorVision/setup.py');
    expect(names.some((name) => name.includes('build/'))).toBe(false);
  });

  it('refuses a corresponding-source download that omits a packaged source', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'omitted-source');
    await rewriteSourceArchive(tampered, (archive) => {
      archive.remove('keeper/package.json');
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'omitted-source-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/does not carry keeper\/package\.json/);
  });

  it('refuses a corresponding-source download carrying stale bytes', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'tampered-source');
    await rewriteSourceArchive(tampered, (archive) => {
      archive.file('keeper/package.json', '{"name":"stale bundle"}\n');
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'tampered-source-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/different keeper\/package\.json bytes/);
  });

  it('refuses a corresponding-source download carrying stale upstream source', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'stale-upstream-source');
    await rewriteSourceArchive(tampered, (archive) => {
      archive.file('CollectorVision/collector_vision/__init__.py', '# stale upstream\n');
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'stale-upstream-source-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/different CollectorVision\/collector_vision\/__init__\.py bytes/);
  });

  it('refuses a corresponding-source download with an additional entry', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'extra-source');
    await rewriteSourceArchive(tampered, (archive) => {
      archive.file('keeper/src/recognition/python/extra.py', '"""not bundled"""\n');
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'extra-source-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/does not assemble from this checkout/);
  });

  it('refuses a prepared catalog without the cached offline feed', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'missing-feed');
    await rm(path.join(tampered, 'src/recognition/python/artifacts/catalog/catalog-v2/feed.json'));
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'missing-feed-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/feed\.json/);
  });

  it('refuses a cached feed that is not the committed one', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'stale-feed');
    await write(
      tampered,
      'src/recognition/python/artifacts/catalog/catalog-v2/feed.json',
      '{"checked_at":"2026-01-01T00:00:00Z","families":{}}\n',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'stale-feed-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/catalog-feed\.json/);
  });

  it('refuses a browser manifest without the pinned upstream identity', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'missing-upstream');
    await rewriteVisualManifest(tampered, (manifest) => {
      delete manifest['upstream'];
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'missing-upstream-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/upstream/);
  });

  it('refuses a browser manifest naming a different upstream identity', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'substituted-upstream');
    await rewriteVisualManifest(tampered, (manifest) => {
      const upstream = manifest['upstream'] as { code: string; catalog: { rows: number } };
      upstream.code = '1'.repeat(40);
      upstream.catalog.rows = 5;
    });
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'substituted-upstream-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/pinned upstream revision/);
  });

  it('refuses browser assets that fail their integrity check', async () => {
    const tampered = await cloneCheckout(prepared, workspace, 'tampered-visual');
    const manifest = JSON.parse(
      await readFile(
        path.join(tampered, 'src/recognition/browser/vendor/visual/manifest.json'),
        'utf8',
      ),
    ) as { readonly assets: { readonly cornelius: { readonly file: string } } };
    await write(
      tampered,
      `src/recognition/browser/vendor/visual/${manifest.assets.cornelius.file}`,
      'substituted geometry',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'tampered-visual-artifacts'),
        repoRoot: tampered,
        revision,
      }),
    ).rejects.toThrow(/cornelius/);
  });

  it('requires the retained preparation before packaging', async () => {
    const unprepared = path.join(workspace, 'unprepared');
    await write(
      unprepared,
      'package.json',
      '{"name":"magic-collection-keeper","version":"0.1.0"}\n',
    );
    await expect(
      packageRecognition({
        outDir: path.join(workspace, 'unprepared-artifacts'),
        repoRoot: unprepared,
        revision,
      }),
    ).rejects.toThrow(/prepare:recognition/);
  });

  it('keeps the recognition artifact beside the other packaged artifacts', async () => {
    const outDir = path.join(workspace, 'shared-artifacts');
    await write(outDir, `${recognitionArtifactLayout.directory}/manifest.json`, '{"schema":1}\n');
    await packageArtifacts({ outDir, revision });
    expect(existsSync(path.join(outDir, recognitionArtifactLayout.manifest))).toBe(true);
    expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
  }, 120_000);
});

describe('the pinned browser recognition runtime', () => {
  it('matches the locked ONNX Runtime Web the preserved modules resolve', async () => {
    const pin = await verifyBrowserRuntimePin(repoRoot);
    expect(pin.package).toBe('onnxruntime-web');
    expect(pin.version).toBe('1.29.0');
    expect(Object.keys(pin.modules)).toContain('ort.wasm.min.mjs');
    // The preserved module verifies exactly this runtime file before it executes the models.
    const assets = await readFile(
      path.join(repoRoot, 'src/recognition/browser/visual-assets.js'),
      'utf8',
    );
    expect(assets).toContain(pin.runtime.file);
  });

  it('is required of a checkout before its engine can be packaged', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'keeper-recognition-empty-'));
    try {
      const engine = path.join(workspace, 'src', 'recognition', 'python');
      await mkdir(path.join(engine, 'artifacts'), { recursive: true });
      await writeFile(path.join(engine, 'source.zip'), 'not a bundle');
      await expect(verifyPreparedRecognition(workspace)).rejects.toThrow(/prepare:recognition/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function cloneCheckout(
  prepared: PreparedCheckout,
  workspace: string,
  name: string,
): Promise<string> {
  const target = path.join(workspace, name);
  await cp(prepared.root, target, { recursive: true });
  return target;
}

/** Rewrites the prepared corresponding-source download, as a stale or tampered bundle would be. */
async function rewriteSourceArchive(root: string, change: (archive: JSZip) => void): Promise<void> {
  const file = path.join(root, 'src', 'recognition', 'python', 'source.zip');
  const archive = await JSZip.loadAsync(await readFile(file));
  change(archive);
  await writeFile(
    file,
    await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
}

/** Rewrites the prepared browser visual manifest, as substituted packaging metadata would be. */
async function rewriteVisualManifest(
  root: string,
  change: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const file = path.join(
    root,
    'src',
    'recognition',
    'browser',
    'vendor',
    'visual',
    'manifest.json',
  );
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  change(manifest);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
