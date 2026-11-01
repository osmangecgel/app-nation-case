import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Env } from '#core/config/env.validation.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { NotFoundError, ValidationError } from '#core/errors/app-errors.ts';
import { CommonErrorCode, FieldErrorCode } from '#core/errors/error-codes.ts';
import { afterCursor, pageOf } from '#core/http/pagination.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { JobConfigService, type JobRoute, type JobTypeConfig } from '#modules/job-config/job-config.service.ts';
import { JobContentsService, messageKeyOf } from '#modules/job-contents/job-contents.service.ts';
import { JobIdempotencyService } from '#modules/job-idempotency/job-idempotency.service.ts';
import { JobOutboxService } from '#modules/job-outbox/job-outbox.service.ts';
import { UsersService } from '#modules/users/users.service.ts';
import { Prisma } from '#generated/prisma/client.ts';
import { JobStatus } from '#generated/prisma/enums.ts';
import { contentHash, countChars, normalizeInput, requestHash } from '#shared/job-content.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';
import {
  type JobCreatedDto,
  type JobDto,
  type JobPageDto,
  type ListJobsQuery,
  JOB_DETAIL_SELECT,
  JOB_LIST_SELECT,
  toJobDto,
  toJobListItemDto,
} from './dto/job.dto.ts';
import { JobLogEvent } from './jobs.constants.ts';
import { JobErrorCode } from './jobs.errors.ts';

export type CreateJobCommand = {
  userId: string;
  idempotencyKey: string;
  type: string;
  input: string;
};

// Everything the transaction needs, computed before it starts.
type PreparedJob = CreateJobCommand & {
  jobId: string;
  jobType: JobTypeConfig;
  route: JobRoute;
  normalizedInput: string;
  contentHash: Buffer;
  requestHash: Buffer;
  requestId: string;
};

type CreateJobResult = { jobId: string; replayed: boolean };

// Jobs created outside an HTTP request (seed, tests).
const NO_REQUEST_ID = 'none';

function invalidField(field: string, code: FieldErrorCode, message: string): ValidationError {
  return new ValidationError(CommonErrorCode.VALIDATION_FAILED, '1 field is invalid.', [{ field, code, message }]);
}

// Owns jobs. Creating a job is the one flow that spans tables, so this service
// decides the order and the transaction; each table is written only by the
// module that owns it.
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly maxActiveJobs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly jobConfig: JobConfigService,
    private readonly contents: JobContentsService,
    private readonly idempotency: JobIdempotencyService,
    private readonly outbox: JobOutboxService,
    private readonly context: RequestContext,
    config: ConfigService<Env, true>,
  ) {
    this.maxActiveJobs = config.get('MAX_ACTIVE_JOBS_PER_USER', { infer: true });
  }

  async create(command: CreateJobCommand): Promise<JobCreatedDto> {
    const job = this.prepare(command);
    const result = await this.prisma.$transaction((tx) => this.createInTransaction(tx, job), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    const event = result.replayed ? JobLogEvent.JOB_REQUEST_REPLAYED : JobLogEvent.JOB_CREATED;
    this.logger.log(event, { jobId: result.jobId, jobType: command.type });
    return { jobId: result.jobId, status: JobStatus.queued };
  }

  async get(userId: string, jobId: string): Promise<JobDto> {
    // A malformed id is reported like another user's job: nothing reveals which ids exist.
    const job = z.uuid().safeParse(jobId).success
      ? await this.prisma.job.findFirst({ where: { id: jobId, user_id: userId }, select: JOB_DETAIL_SELECT })
      : null;
    if (!job) {
      throw new NotFoundError(JobErrorCode.JOB_NOT_FOUND, 'Job was not found.');
    }
    return toJobDto(job);
  }

  // Newest first. Ids are UUID v7, so ordering by id is ordering by creation
  // time, and the cursor continues from the last id without OFFSET.
  async list(userId: string, query: ListJobsQuery): Promise<JobPageDto> {
    const rows = await this.prisma.job.findMany({
      where: { user_id: userId, ...(query.status ? { status: query.status } : {}), ...afterCursor(query.cursor) },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: JOB_LIST_SELECT,
    });
    return pageOf(rows, query.limit, toJobListItemDto);
  }

  private prepare(command: CreateJobCommand): PreparedJob {
    const jobType = this.jobConfig.findType(command.type);
    if (!jobType) {
      const supported = this.jobConfig.typeCodes().join(', ');
      throw invalidField('type', FieldErrorCode.INVALID_VALUE, `Unknown job type. Supported: ${supported}.`);
    }
    if (countChars(command.input) > jobType.maxInputChars) {
      throw invalidField('input', FieldErrorCode.TOO_BIG, `Must be at most ${jobType.maxInputChars} characters.`);
    }
    const normalizedInput = normalizeInput(command.input);
    if (normalizedInput.length === 0) {
      throw invalidField('input', FieldErrorCode.TOO_SMALL, 'Must not be blank.');
    }
    const route = this.jobConfig.pickRoute(jobType);
    return {
      ...command,
      jobId: uuidV7(),
      jobType,
      route,
      normalizedInput,
      contentHash: contentHash({
        jobTypeCode: jobType.code,
        promptVersion: jobType.promptVersion,
        providerCode: route.providerCode,
        modelVersion: route.modelVersion,
        normalizedInput,
      }),
      requestHash: requestHash(command.type, command.input),
      requestId: this.context.requestId() ?? NO_REQUEST_ID,
    };
  }

  // Order matters:
  // 1. The key is claimed first, so a concurrent request with the same key
  //    waits there before doing any work.
  // 2. The user's row is locked last (reserveCredits), so the lock every
  //    request of that user competes for is held only until commit.
  // A thrown error rolls everything back, including the key: a request
  // rejected with 402 can be retried with the same key after a top-up.
  private async createInTransaction(tx: Prisma.TransactionClient, job: PreparedJob): Promise<CreateJobResult> {
    await this.users.requireUser(tx, job.userId);
    const earlierJobId = await this.idempotency.claim(tx, {
      userId: job.userId,
      idempotencyKey: job.idempotencyKey,
      requestHash: job.requestHash,
      jobId: job.jobId,
    });
    if (earlierJobId) {
      return { jobId: earlierJobId, replayed: true };
    }
    const contentId = await this.contents.upsert(tx, {
      jobTypeCode: job.jobType.code,
      contentHash: job.contentHash,
      normalizedInput: job.normalizedInput,
    });
    await this.insertJob(tx, job, contentId);
    // In the same transaction as the job, so a committed job is always dispatched.
    await this.outbox.enqueue(tx, {
      jobId: job.jobId,
      messageKey: messageKeyOf(job.contentHash),
      requestId: job.requestId,
    });
    await this.users.reserveCredits(tx, {
      userId: job.userId,
      jobId: job.jobId,
      cost: job.jobType.cost,
      maxActiveJobs: this.maxActiveJobs,
    });
    return { jobId: job.jobId, replayed: false };
  }

  // The route and price are copied onto the job: a later config change never
  // affects a job already accepted.
  private async insertJob(tx: Prisma.TransactionClient, job: PreparedJob, contentId: string): Promise<void> {
    await tx.job.create({
      data: {
        id: job.jobId,
        user_id: job.userId,
        job_content_id: contentId,
        job_provider_code: job.route.providerCode,
        model_version: job.route.modelVersion,
        cost: job.jobType.cost,
      },
      select: { id: true },
    });
  }
}
