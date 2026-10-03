import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import JSZip from 'jszip';

import { contentIdentity } from './deployment-record.js';

/** Hash the complete component context and build arguments, excluding source labels. */
export async function imageInputsIdentity(
  directory: string,
  buildArguments: Readonly<Record<string, string>> = {},
): Promise<string> {
  const files: Record<string, unknown> = {};
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      // Recognition writes its provenance manifest beside the context; Docker never COPYs it.
      if (name === 'manifest.json') continue;
      if (entry.isDirectory()) {
        files[name] = {
          directory: true,
          mode: (await stat(path.join(directory, name))).mode & 0o777,
        };
        await walk(name);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported image context entry: ${name}`);
      const file = path.join(directory, name);
      const bytes = await readFile(file);
      let content: unknown = createHash('sha256').update(bytes).digest('hex');
      if (name === 'source.zip') {
        // source_bundle.py records checkout timestamps. They do not change corresponding source.
        const archive = await JSZip.loadAsync(bytes);
        const entries: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(archive.files)) {
          entries[key] = {
            directory: value.dir,
            unixPermissions: value.unixPermissions,
            dosPermissions: value.dosPermissions,
            content: createHash('sha256')
              .update(await value.async('nodebuffer'))
              .digest('hex'),
          };
        }
        content = entries;
      }
      files[name] = { content, mode: (await stat(file)).mode & 0o777 };
    }
  }
  await walk('');
  return contentIdentity({ platform: 'linux/amd64', buildArguments, files });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('An image context directory is required.');
  const baseImage = process.argv[3];
  if (baseImage !== undefined && !/@sha256:[0-9a-f]{64}$/.test(baseImage)) {
    throw new Error('The Node base image must be pinned by digest.');
  }
  console.log(
    await imageInputsIdentity(
      directory,
      baseImage === undefined ? {} : { NODE_BASE_IMAGE: baseImage },
    ),
  );
}
