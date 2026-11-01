import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '#modules/job-idempotency/job-idempotency.constants.ts';

// The header as clients write it: the field name in a validation error.
const FIELD = 'Idempotency-Key';

const IdempotencyKeyHeaderSchema = z.object({ [FIELD]: z.string().max(IDEMPOTENCY_KEY_MAX_LENGTH) });
const validate = new ZodValidationPipe(IdempotencyKeyHeaderSchema);

// The required Idempotency-Key header, validated and reported like any other
// field (CODE-11, ERR-04). An empty header counts as a missing one.
export const IdempotencyKey = createParamDecorator((_data: never, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER);
  return validate.transform({ [FIELD]: value === '' ? undefined : value })[FIELD];
});
