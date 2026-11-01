import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { type FieldError, ValidationError } from '#core/errors/app-errors.ts';
import { CommonErrorCode, FieldErrorCode } from '#core/errors/error-codes.ts';

const FIELD_CODE_BY_ISSUE: Partial<Record<z.core.$ZodIssue['code'], FieldErrorCode>> = {
  invalid_type: FieldErrorCode.INVALID_TYPE,
  invalid_format: FieldErrorCode.INVALID_FORMAT,
  invalid_value: FieldErrorCode.INVALID_VALUE,
  too_small: FieldErrorCode.TOO_SMALL,
  too_big: FieldErrorCode.TOO_BIG,
};
const REQUIRED_MESSAGE = 'Field is required.';

function valueAt(input: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined),
    input,
  );
}

function toFieldPath(path: PropertyKey[]): string {
  return path.map(String).join('.');
}

function toFieldErrors(issue: z.core.$ZodIssue, input: unknown): FieldError[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      field: toFieldPath([...issue.path, key]),
      code: FieldErrorCode.UNKNOWN_FIELD,
      message: issue.message,
    }));
  }
  const field = toFieldPath(issue.path);
  if (issue.code === 'invalid_type' && valueAt(input, issue.path) === undefined) {
    return [{ field, code: FieldErrorCode.REQUIRED, message: REQUIRED_MESSAGE }];
  }
  return [{ field, code: FIELD_CODE_BY_ISSUE[issue.code] ?? FieldErrorCode.INVALID_VALUE, message: issue.message }];
}

// `?status=&limit=` is how clients send "no filter": an empty query
// parameter counts as not given, so it gets its default instead of a 400.
function withoutEmptyQueryValues(value: unknown, metadata?: ArgumentMetadata): unknown {
  if (metadata?.type !== 'query' || typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== ''));
}

function describeInvalidFields(count: number): string {
  return count === 1 ? '1 field is invalid.' : `${count} fields are invalid.`;
}

// Validates request input against a zod schema and reports every invalid field (CODE-11, ERR-04).
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, metadata?: ArgumentMetadata): z.output<TSchema> {
    const input = withoutEmptyQueryValues(value, metadata);
    const result = this.schema.safeParse(input);
    if (result.success) {
      return result.data;
    }
    const errors = result.error.issues.flatMap((issue) => toFieldErrors(issue, input));
    throw new ValidationError(CommonErrorCode.VALIDATION_FAILED, describeInvalidFields(errors.length), errors);
  }
}
