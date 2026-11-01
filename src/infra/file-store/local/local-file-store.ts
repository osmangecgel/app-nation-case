import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { FileStore, type FileUpload } from '#infra/file-store/file-store.ts';

// Keys never contain a path separator, so a key cannot leave the directory.
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.startsWith('.')) {
    throw new Error(`Invalid file key "${key}".`);
  }
}

// Files in one directory (EXPORT_FILES_DIR), shared by the API and the worker
// through a Docker volume. Works for one host; several hosts need an object
// store adapter instead.
@Injectable()
export class LocalFileStore extends FileStore {
  private readonly directory: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.directory = resolve(config.get('EXPORT_FILES_DIR', { infer: true }));
  }

  // Writes to a temporary name; commit renames it, which is atomic on one filesystem.
  async upload(key: string): Promise<FileUpload> {
    assertKey(key);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, key);
    const temporary = join(this.directory, `.${key}.${randomUUID()}.part`);
    const stream = createWriteStream(temporary);
    return {
      stream,
      commit: async () => {
        stream.end();
        await finished(stream);
        await rename(temporary, target);
      },
      abort: async () => {
        // The file may still be opening; removing it before the stream has
        // closed would let the open create it again afterwards.
        if (!stream.closed) {
          const closed = once(stream, 'close');
          stream.destroy();
          await closed;
        }
        await rm(temporary, { force: true });
      },
    };
  }

  async open(key: string): Promise<Readable | null> {
    assertKey(key);
    const path = join(this.directory, key);
    try {
      await stat(path);
    } catch {
      return null;
    }
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await rm(join(this.directory, key), { force: true });
  }
}
