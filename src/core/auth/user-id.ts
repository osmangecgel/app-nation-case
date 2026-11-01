import { z } from 'zod';
import { USER_ID_MAX_LENGTH } from './auth.constants.ts';

// Printable characters only, so the id is safe in logs, URLs and CSV file names.
export const UserIdSchema = z
  .string()
  .min(1)
  .max(USER_ID_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/, 'Must contain printable ASCII characters only.')
  .meta({ description: 'Caller id. Authentication is out of scope.', example: 'user-1' });
