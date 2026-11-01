import { Injectable } from '@nestjs/common';
import { BusinessRuleError, ConflictError } from '#core/errors/app-errors.ts';
import { CommonErrorCode } from '#core/errors/error-codes.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import {
  IDEMPOTENCY_KEY_TTL_SECONDS,
  JobIdempotencyErrorCode,
  MAX_KEY_CLAIM_ATTEMPTS,
} from './job-idempotency.constants.ts';

export type KeyClaim = {
  userId: string;
  idempotencyKey: string;
  requestHash: Buffer;
  // The job this request will create if the key is new.
  jobId: string;
};

type ExistingKey = { request_hash: Uint8Array; job_id: string; expired: boolean };

// Owns job_idempotency_keys: the first accepted request for each (user, key).
@Injectable()
export class JobIdempotencyService {
  // Returns null when the key is claimed for claim.jobId, or the job id of the
  // earlier request with the same key and body. Throws when the key was used
  // with a different body.
  //
  // Call it before any other write: a concurrent claim of the same key waits on
  // ON CONFLICT until the first transaction commits or rolls back, so the
  // second request does no work. The follow-up read, a new statement, sees the
  // committed row. If the first transaction rolled back, the retry claims it.
  async claim(tx: Prisma.TransactionClient, claim: KeyClaim): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_KEY_CLAIM_ATTEMPTS; attempt += 1) {
      const claimed = await tx.$queryRaw<{ job_id: string }[]>`
        INSERT INTO job_idempotency_keys (user_id, idempotency_key, request_hash, job_id, expires_at)
        VALUES (${claim.userId}, ${claim.idempotencyKey}, ${claim.requestHash}, ${claim.jobId}::uuid,
                now() + make_interval(secs => ${IDEMPOTENCY_KEY_TTL_SECONDS}))
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING job_id`;
      if (claimed.length > 0) {
        return null;
      }
      const earlierJobId = await this.findLiveKey(tx, claim);
      if (earlierJobId) {
        return earlierJobId;
      }
    }
    throw new ConflictError(CommonErrorCode.CONFLICT, 'The request conflicted with a concurrent request. Try again.');
  }

  // Null when the key has expired (it is removed, so the claim can be retried)
  // or was removed in the meantime.
  private async findLiveKey(tx: Prisma.TransactionClient, claim: KeyClaim): Promise<string | null> {
    const [key] = await tx.$queryRaw<ExistingKey[]>`
      SELECT request_hash, job_id, expires_at <= now() AS expired
        FROM job_idempotency_keys
       WHERE user_id = ${claim.userId} AND idempotency_key = ${claim.idempotencyKey}`;
    if (!key) {
      return null;
    }
    if (key.expired) {
      await tx.$executeRaw`
        DELETE FROM job_idempotency_keys
         WHERE user_id = ${claim.userId} AND idempotency_key = ${claim.idempotencyKey} AND expires_at <= now()`;
      return null;
    }
    if (!Buffer.from(key.request_hash).equals(claim.requestHash)) {
      throw new BusinessRuleError(
        JobIdempotencyErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Idempotency-Key was already used with a different request body.',
      );
    }
    return key.job_id;
  }
}
