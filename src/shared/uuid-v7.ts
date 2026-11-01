import { randomBytes } from 'node:crypto';

const TIMESTAMP_BYTES = 6;
const VERSION_7 = 0x70;
const VARIANT_RFC_9562 = 0x80;

// UUID v7 (RFC 9562): a 48-bit millisecond timestamp followed by random bits,
// so ids sort by creation time. Prisma generates them on insert; this is for
// ids the app needs before the insert (a job id in a single-statement create)
// and for seed rows that must carry a past timestamp.
export function uuidV7(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestampMs, 0, TIMESTAMP_BYTES);
  bytes[6] = (bytes[6] & 0x0f) | VERSION_7;
  bytes[8] = (bytes[8] & 0x3f) | VARIANT_RFC_9562;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV7Timestamp(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, TIMESTAMP_BYTES * 2), 16);
}
