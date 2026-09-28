/**
 * Helpers shared by the packaging commands (scripts/package-artifacts.ts,
 * scripts/package-recognition.ts). They belong to no single command: they describe the checkout a
 * release is built from and the bytes of one artifact, and they hold no command-line behavior of
 * their own, so importing them never runs a packaging step.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Repository root of the running checkout; evaluated when a command starts. */
export const repoRoot = findRepoRoot();

export function findRepoRoot(): string {
  let current = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(current, 'src', 'application', 'lambda.ts'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Run the packaging command from inside the repository checkout.');
    }
    current = parent;
  }
}

export interface ArtifactFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The checked-out revision; packaging without one produces artifacts nothing can restore. */
export function readRevision(root: string = repoRoot): string {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('The repository does not report the revision of this checkout.');
  }
  return revision;
}

export function readWorkingTree(root: string): 'clean' | 'dirty' {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  return status.trim() === '' ? 'clean' : 'dirty';
}

export function readPackageVersion(root: string): string {
  const text = readFileSync(path.join(root, 'package.json'), 'utf8');
  const version = JSON.parse(text).version;
  return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
}

export async function describeFile(root: string, file: string): Promise<ArtifactFile> {
  const content = await readFile(path.join(root, file));
  return {
    file,
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
