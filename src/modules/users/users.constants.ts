export const MAX_GRANT_AMOUNT = 1_000_000;

// The largest value of the INTEGER credit columns. A grant may not take a
// user's credits (balance plus reserved) past it; then no later release, which
// moves reserved credits back to the balance, can overflow either.
export const MAX_USER_CREDITS = 2_147_483_647;

// In constants (not users.errors.ts) because the jobs module documents them on
// POST /v1/jobs, and other modules may import only a module's constants.
export const UserErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  TOO_MANY_ACTIVE_JOBS: 'TOO_MANY_ACTIVE_JOBS',
  BALANCE_LIMIT_EXCEEDED: 'BALANCE_LIMIT_EXCEEDED',
} as const;

export const UserLogEvent = {
  CREDITS_GRANTED: 'CREDITS_GRANTED',
} as const;
