import { createHash } from 'node:crypto';

// The case's normalisation: trim, lowercase, collapse runs of whitespace.
// NFC first, so the same text typed with combining characters gets the same key.
// toLowerCase is locale-independent on purpose: the result must not depend on
// the server's locale ('İ' becomes 'i̇', not 'i').
export function normalizeInput(input: string): string {
  return input.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Unicode code points, the unit PostgreSQL's char_length counts: an emoji is
// one, not the two UTF-16 units string.length reports.
export function countChars(input: string): number {
  let count = 0;
  for (const _codePoint of input) {
    count += 1;
  }
  return count;
}

export type ContentKey = {
  jobTypeCode: string;
  promptVersion: string;
  providerCode: string;
  modelVersion: string;
  normalizedInput: string;
};

// Identity of a result. Stored results never expire; they are renewed by
// changing what produced them: a new prompt, provider or model changes the
// hash, so the old answer is never served for the new setup. The provider is
// included because two providers may offer a model under the same name.
// JSON keeps the parts apart, so no input can be crafted to collide with
// another combination of parts.
export function contentHash(key: ContentKey): Buffer {
  const parts = [key.jobTypeCode, key.promptVersion, key.providerCode, key.modelVersion, key.normalizedInput];
  return createHash('sha256').update(JSON.stringify(parts)).digest();
}

// Identity of a request, for Idempotency-Key reuse: the raw body, not the
// normalised one, so "Merhaba" and "merhaba" are different requests.
export function requestHash(jobTypeCode: string, input: string): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([jobTypeCode, input]))
    .digest();
}
