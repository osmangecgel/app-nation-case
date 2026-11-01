import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { UserId, UserIdGuard } from '#core/auth/user-id.guard.ts';
import { AuthErrorCode, USER_ID_MAX_LENGTH } from '#core/auth/auth.constants.ts';
import { CommonErrorCode } from '#core/errors/error-codes.ts';
import { ApiEndpoint } from '#core/http/openapi/api-endpoint.decorator.ts';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import { JobExportSchema } from '#modules/job-exports/dto/job-export.dto.ts';
import { ExportDownloadService } from '#modules/job-exports/export-download.service.ts';
import { JobExportErrorCode } from '#modules/job-exports/job-exports.constants.ts';
import { UserErrorCode } from '#modules/users/users.constants.ts';
import {
  type CreateJobDto,
  CreateJobSchema,
  type JobCreatedDto,
  JobCreatedSchema,
  type JobDto,
  type JobIdParams,
  JobIdParamsSchema,
  type JobPageDto,
  JobPageSchema,
  JobSchema,
  type ListJobsQuery,
  ListJobsQuerySchema,
} from './dto/job.dto.ts';
import { IdempotencyKey } from './idempotency-key.decorator.ts';
import { JobsService } from './jobs.service.ts';
import { JobErrorCode } from './jobs.errors.ts';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  JobIdempotencyErrorCode,
} from '#modules/job-idempotency/job-idempotency.constants.ts';

const UNAUTHORIZED = { status: HttpStatus.UNAUTHORIZED, code: AuthErrorCode.USER_ID_REQUIRED };

@ApiTags('jobs')
@ApiHeader({
  name: 'X-User-Id',
  required: true,
  description: `Caller id: 1 to ${USER_ID_MAX_LENGTH} printable ASCII characters. Authentication is out of scope.`,
})
@Controller('jobs')
@UseGuards(UserIdGuard)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly exportDownload: ExportDownloadService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: `Unique per request, at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters. A retry with the same key and body returns the first response for 24 hours.`,
  })
  @ApiEndpoint({
    summary: 'Start a job',
    description: 'Reserves the job cost from the balance and queues the job. The result is fetched later by job id.',
    body: CreateJobSchema,
    response: { status: HttpStatus.ACCEPTED, schema: JobCreatedSchema },
    errors: [
      UNAUTHORIZED,
      { status: HttpStatus.PAYMENT_REQUIRED, code: UserErrorCode.INSUFFICIENT_CREDITS },
      { status: HttpStatus.UNPROCESSABLE_ENTITY, code: JobIdempotencyErrorCode.IDEMPOTENCY_KEY_REUSED },
      { status: HttpStatus.TOO_MANY_REQUESTS, code: UserErrorCode.TOO_MANY_ACTIVE_JOBS },
      // A concurrent request with the same key, or a concurrent change, got in the way; retrying is safe.
      { status: HttpStatus.CONFLICT, code: CommonErrorCode.CONFLICT },
    ],
  })
  create(
    @UserId() userId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(CreateJobSchema)) body: CreateJobDto,
  ): Promise<JobCreatedDto> {
    return this.jobs.create({ userId, idempotencyKey, type: body.type, input: body.input });
  }

  // Declared before :id, otherwise "export.csv" would be taken for a job id.
  @Get('export.csv')
  @ApiProduces('text/csv')
  @ApiEndpoint({
    summary: 'Download all jobs as CSV',
    description:
      'Every job of the caller, newest first. Columns: job_id, type, status, cost, error_code, created_at, ' +
      'finished_at. EXPORT_MODE stream (default) streams the file; async answers 202 with an export to poll ' +
      '(see /v1/exports); auto streams up to EXPORT_STREAM_MAX_ROWS jobs and answers 202 above. ' +
      'At most one streamed export per user and a bounded number in total: a request waits up to ' +
      'EXPORT_ADMISSION_WAIT_MS for a slot, then gets 429 with Retry-After.',
    response: [
      { status: HttpStatus.OK, description: 'CSV file.' },
      {
        status: HttpStatus.ACCEPTED,
        schema: JobExportSchema,
        description: 'Prepared in the background; poll Location.',
      },
    ],
    errors: [
      UNAUTHORIZED,
      { status: HttpStatus.TOO_MANY_REQUESTS, code: JobExportErrorCode.EXPORT_IN_PROGRESS },
      { status: HttpStatus.TOO_MANY_REQUESTS, code: JobExportErrorCode.EXPORT_SLOTS_BUSY },
    ],
  })
  export(@UserId() userId: string, @Res() response: Response): Promise<void> {
    return this.exportDownload.serve(userId, response);
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'Get a job',
    description:
      'Status, result when completed and error code when failed. Another user’s job is reported as not found.',
    params: JobIdParamsSchema,
    paramsTakeAnyValue: true,
    response: { status: HttpStatus.OK, schema: JobSchema },
    errors: [UNAUTHORIZED, { status: HttpStatus.NOT_FOUND, code: JobErrorCode.JOB_NOT_FOUND }],
  })
  get(@UserId() userId: string, @Param(new ZodValidationPipe(JobIdParamsSchema)) params: JobIdParams): Promise<JobDto> {
    return this.jobs.get(userId, params.id);
  }

  @Get()
  @ApiEndpoint({
    summary: 'List jobs',
    description: 'Newest first, with cursor pagination.',
    query: ListJobsQuerySchema,
    response: { status: HttpStatus.OK, schema: JobPageSchema },
    errors: [UNAUTHORIZED],
  })
  list(
    @UserId() userId: string,
    @Query(new ZodValidationPipe(ListJobsQuerySchema)) query: ListJobsQuery,
  ): Promise<JobPageDto> {
    return this.jobs.list(userId, query);
  }
}
