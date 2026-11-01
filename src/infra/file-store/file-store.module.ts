import { Module } from '@nestjs/common';
import { FileStore } from './file-store.ts';
import { LocalFileStore } from './local/local-file-store.ts';

// Binds the FileStore port to the local adapter. An object store (S3) would be
// another adapter folder bound here, as QueueModule does for brokers.
@Module({
  providers: [{ provide: FileStore, useClass: LocalFileStore }],
  exports: [FileStore],
})
export class FileStoreModule {}
