import type { JobResultSource } from '#generated/prisma/enums.ts';

// What processing a job came to; settle() turns it into database changes.
export type JobOutcome =
  | { kind: 'completed'; text: string; source: JobResultSource }
  | { kind: 'transient'; errorCode: string }
  | { kind: 'permanent'; errorCode: string }
  // Stopped by the worker itself: shutdown puts the job back, a lost lease leaves it to its new owner.
  | { kind: 'interrupted'; reason: 'shutdown' | 'lease_lost' };

// What resolving a job came to. A job is claimed only right before its provider
// call, so a resolution may also end with the claim refused: the job finished
// or another worker holds it, and there is nothing to settle.
export type Resolution = JobOutcome | { kind: 'not_claimed' };

// Delay before the next attempt after `attemptCount` attempts: 1 s, 2 s, 4 s, ... plus jitter.
export function retryDelayMs(attemptCount: number, baseMs: number, jitterMs: number, random = Math.random()): number {
  return baseMs * 2 ** (attemptCount - 1) + Math.floor(random * jitterMs);
}
