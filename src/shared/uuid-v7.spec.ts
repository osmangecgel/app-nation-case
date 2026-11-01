import { z } from 'zod';
import { uuidV7, uuidV7Timestamp } from './uuid-v7.ts';

describe('uuidV7', () => {
  it('produces a valid version 7 UUID', () => {
    const id = uuidV7();

    expect(z.uuid({ version: 'v7' }).safeParse(id).success).toBe(true);
  });

  it('carries the given timestamp', () => {
    const timestamp = Date.UTC(2026, 4, 1, 12, 30, 15, 123);

    expect(uuidV7Timestamp(uuidV7(timestamp))).toBe(timestamp);
  });

  it('sorts by creation time', () => {
    const ids = [uuidV7(3_000), uuidV7(1_000), uuidV7(2_000)];

    expect(ids.toSorted()).toEqual([ids[1], ids[2], ids[0]]);
  });
});
