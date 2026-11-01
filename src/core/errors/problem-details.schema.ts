import { z } from 'zod';
import { FieldErrorCode } from './error-codes.ts';

// The RFC 9457 error body (ERR-01), for the API documentation.
export const ProblemDetailsSchema = z
  .object({
    title: z.string().meta({ description: 'HTTP status text.', example: 'Payment Required' }),
    status: z.number().int().meta({ description: 'HTTP status code.', example: 402 }),
    detail: z
      .string()
      .meta({ description: 'Developer-facing explanation in English.', example: 'Not enough credits for this job.' }),
    instance: z.string().meta({ description: 'Request path.', example: '/v1/jobs' }),
    code: z
      .string()
      .meta({ description: 'Stable error code; clients choose their message by it.', example: 'INSUFFICIENT_CREDITS' }),
    error: z
      .string()
      .meta({ description: 'The code in lowercase, for clients that read error.', example: 'insufficient_credits' }),
    requestId: z.string().meta({
      description: 'Id of the request, for support. Same as the x-request-id header and the requestId in our logs.',
      example: '4bf92f3577b34da6a3ce929d0e0e4736',
    }),
    errors: z
      .array(
        z.object({
          field: z.string().meta({ description: 'Path of the invalid field.', example: 'input' }),
          code: z
            .enum(FieldErrorCode)
            .meta({ description: 'Stable field error code.', example: FieldErrorCode.REQUIRED }),
          message: z
            .string()
            .meta({ description: 'Developer-facing explanation in English.', example: 'Field is required.' }),
        }),
      )
      .optional()
      .describe('Field-level errors, only for validation failures.'),
  })
  .meta({ id: 'ProblemDetails', description: 'RFC 9457 problem details.' });
