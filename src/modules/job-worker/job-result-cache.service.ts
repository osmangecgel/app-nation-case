import { Injectable } from '@nestjs/common';
import { CacheService } from '#infra/cache/cache.service.ts';

// Keys are the content hash (hex), which already includes the job type, model
// and prompt version: a summary and a translation of the same text never share
// a key, and a new model never sees the old model's results.
const RESULT_DOMAIN = 'job_result';
const FAILURE_DOMAIN = 'job_failure';
const CALL_LOCK_DOMAIN = 'job_call_lock';

// A permanent rejection is remembered briefly: the same input sent again is
// refunded without another paid provider call.
export const FAILURE_CACHE_TTL_SECONDS = 5 * 60;

// The worker's view of the cache Redis. Every method treats an unavailable
// Redis as "nothing cached" or "no lock", so processing goes on without it.
@Injectable()
export class JobResultCacheService {
  constructor(private readonly cache: CacheService) {}

  getResult(contentKey: string): Promise<string | null> {
    return this.cache.get(RESULT_DOMAIN, contentKey);
  }

  setResult(contentKey: string, result: string, ttlSeconds: number): Promise<void> {
    return this.cache.set(RESULT_DOMAIN, contentKey, result, ttlSeconds);
  }

  getFailure(contentKey: string): Promise<string | null> {
    return this.cache.get(FAILURE_DOMAIN, contentKey);
  }

  setFailure(contentKey: string, errorCode: string): Promise<void> {
    return this.cache.set(FAILURE_DOMAIN, contentKey, errorCode, FAILURE_CACHE_TTL_SECONDS);
  }

  // One provider call per content across all workers. Null: Redis is down.
  acquireCallLock(contentKey: string, token: string, ttlMs: number): Promise<boolean | null> {
    return this.cache.acquireLock(CALL_LOCK_DOMAIN, contentKey, token, ttlMs);
  }

  // Restarts the lock's expiry; the provider call is about to start.
  extendCallLock(contentKey: string, token: string, ttlMs: number): Promise<boolean | null> {
    return this.cache.extendLock(CALL_LOCK_DOMAIN, contentKey, token, ttlMs);
  }

  releaseCallLock(contentKey: string, token: string): Promise<void> {
    return this.cache.releaseLock(CALL_LOCK_DOMAIN, contentKey, token);
  }

  isCallLocked(contentKey: string): Promise<boolean | null> {
    return this.cache.exists(CALL_LOCK_DOMAIN, contentKey);
  }
}
