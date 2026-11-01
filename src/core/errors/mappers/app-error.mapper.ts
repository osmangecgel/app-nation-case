import { AppError } from '../app-errors.ts';
import type { ProblemFields, ProblemMapper } from '../problem-mapper.ts';

export class AppErrorMapper implements ProblemMapper {
  canMap(exception: unknown): exception is AppError {
    return exception instanceof AppError;
  }

  map(exception: AppError): ProblemFields {
    const fields: ProblemFields = { status: exception.status, code: exception.code, detail: exception.detail };
    return exception.errors.length > 0 ? { ...fields, errors: exception.errors } : fields;
  }
}
