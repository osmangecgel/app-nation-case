import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { LocalFileStore } from './local-file-store.ts';

describe('LocalFileStore', () => {
  let directory: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'file-store-'));
    store = new LocalFileStore({ get: () => directory } as never);
  });

  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('publishes a file under its key only when committed', async () => {
    const upload = await store.upload('export-1.csv');
    upload.stream.write('a,b\r\n');

    expect(await store.open('export-1.csv')).toBeNull();
    await upload.commit();

    expect(await readFile(join(directory, 'export-1.csv'), 'utf8')).toBe('a,b\r\n');
    const opened = await store.open('export-1.csv');
    expect(opened && (await text(opened))).toBe('a,b\r\n');
  });

  it('leaves nothing behind when aborted', async () => {
    const upload = await store.upload('export-2.csv');
    upload.stream.write('half');

    await upload.abort();

    expect(await readdir(directory)).toEqual([]);
    expect(await store.open('export-2.csv')).toBeNull();
  });

  it('deletes a file, and accepts deleting one that is already gone', async () => {
    const upload = await store.upload('export-3.csv');
    await upload.commit();

    await store.delete('export-3.csv');
    await store.delete('export-3.csv');

    expect(await store.open('export-3.csv')).toBeNull();
  });

  it('refuses a key that could leave the directory', async () => {
    await expect(store.upload('../escape.csv')).rejects.toThrow('Invalid file key');
    await expect(store.open('.hidden')).rejects.toThrow('Invalid file key');
  });
});
