/**
 * Test substitute for the private snapshot bucket: it answers the head and body reads
 * `src/application/deployment.ts` issues, including the recorded provider version, the object
 * version a versioned bucket reports and the way a real object chunks its body. A body request
 * pinned to a version the bucket no longer serves fails, exactly as the deployed bucket would.
 */

import type {
  SnapshotObject,
  SnapshotObjectClient,
  SnapshotObjectCommand,
  SnapshotObjectHandle,
} from '../../src/application/deployment.js';

export interface SnapshotObjectFixture {
  /** Object metadata as the upload recorded it, including the provider version. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Version of this object, as a versioned bucket reports it; absent models an unversioned one. */
  readonly version?: string;
  readonly text?: string;
  /** Explicit chunking of the body; the default splits like a real transfer does. */
  readonly chunks?: readonly string[];
}

export function createSnapshotObjects(
  objects: Readonly<Record<string, SnapshotObjectFixture>>,
): SnapshotObjectClient {
  return {
    async head(command: SnapshotObjectCommand): Promise<SnapshotObjectHandle> {
      const object = readObject(objects, command);
      return { metadata: object.metadata ?? {}, version: object.version ?? null };
    },
    async get(command: SnapshotObjectCommand): Promise<SnapshotObject> {
      const object = readObject(objects, command);
      const version = object.version ?? null;
      if (command.input.VersionId !== undefined && command.input.VersionId !== version) {
        throw new Error(
          `The snapshot object no longer carries version ${command.input.VersionId}.`,
        );
      }
      const text = object.text ?? '';
      const chunks = object.chunks ?? chunk(text);
      return {
        metadata: object.metadata ?? {},
        version,
        body: (async function* stream(): AsyncGenerator<string> {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      };
    },
  };
}

function readObject(
  objects: Readonly<Record<string, SnapshotObjectFixture>>,
  command: SnapshotObjectCommand,
): SnapshotObjectFixture {
  const key = command.input.Key;
  const object = objects[key];
  if (object === undefined) {
    throw new Error(`No snapshot object is configured under ${key}.`);
  }
  return object;
}

function chunk(text: string, size = 64): readonly string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}
