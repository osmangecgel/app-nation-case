import { z } from 'zod';
import { ValidationError } from '#core/errors/app-errors.ts';
import { CommonErrorCode, FieldErrorCode } from '#core/errors/error-codes.ts';
import { ZodValidationPipe } from './zod-validation.pipe.ts';

const CreateItemSchema = z.strictObject({
  name: z.string().min(2),
  quantity: z.number().int().positive(),
  email: z.email().optional(),
  tags: z.array(z.strictObject({ label: z.string() })).optional(),
});

function validationErrorOf(input: object): ValidationError {
  try {
    new ZodValidationPipe(CreateItemSchema).transform(input);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a ValidationError');
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value when the input is valid', () => {
    const pipe = new ZodValidationPipe(CreateItemSchema);

    expect(pipe.transform({ name: 'Lamp', quantity: 2 })).toEqual({ name: 'Lamp', quantity: 2 });
  });

  it('reports VALIDATION_FAILED with one entry per invalid field', () => {
    const error = validationErrorOf({ quantity: 0 });

    expect(error.code).toBe(CommonErrorCode.VALIDATION_FAILED);
    expect(error.detail).toBe('2 fields are invalid.');
    expect(error.errors).toEqual([
      { field: 'name', code: FieldErrorCode.REQUIRED, message: 'Field is required.' },
      { field: 'quantity', code: FieldErrorCode.TOO_SMALL, message: expect.any(String) },
    ]);
  });

  it.each([
    ['a wrong type', { name: 'Lamp', quantity: 'two' }, 'quantity', FieldErrorCode.INVALID_TYPE],
    ['a bad format', { name: 'Lamp', quantity: 1, email: 'nope' }, 'email', FieldErrorCode.INVALID_FORMAT],
    ['an unknown field', { name: 'Lamp', quantity: 1, colour: 'red' }, 'colour', FieldErrorCode.UNKNOWN_FIELD],
    ['a nested array item', { name: 'Lamp', quantity: 1, tags: [{}] }, 'tags.0.label', FieldErrorCode.REQUIRED],
  ])('maps %s to its field error code', (_case, input, field, code) => {
    const error = validationErrorOf(input);

    expect(error.errors).toEqual([expect.objectContaining({ field, code })]);
  });

  it('uses the singular form for a single invalid field', () => {
    expect(validationErrorOf({ name: 'Lamp' }).detail).toBe('1 field is invalid.');
  });
});
