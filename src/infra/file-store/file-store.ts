import type { Readable, Writable } from 'node:stream';

// Where prepared files (background CSV exports) live, as the rest of the code
// sees it. A store is an adapter folder next to this file: local/ today, a
// shared directory; an object store (S3) would be another folder. Keys are
// flat names made of letters, digits, '.', '_' and '-'.

// A file being written. Nothing is visible under the key until commit(), so a
// crash or abort() never leaves a half-written file behind the key.
export type FileUpload = {
  // Honour its backpressure: write() returning false means wait for 'drain'.
  stream: Writable;
  // Ends the stream and publishes the file under its key.
  commit(): Promise<void>;
  // Discards everything written.
  abort(): Promise<void>;
};

// An abstract class rather than an interface: NestJS injects by a runtime token.
export abstract class FileStore {
  abstract upload(key: string): Promise<FileUpload>;
  // Null when no file has that key.
  abstract open(key: string): Promise<Readable | null>;
  // Succeeds when the file is already gone.
  abstract delete(key: string): Promise<void>;
}
