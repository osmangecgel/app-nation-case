import { pipeline } from 'node:stream/promises';
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { UserId, UserIdGuard } from '#core/auth/user-id.guard.ts';
import { AuthErrorCode, USER_ID_MAX_LENGTH } from '#core/auth/auth.constants.ts';
import { RequestContext } from '#core/context/request-context.ts';
import { generateRequestId } from '#core/context/request-id.ts';
import { ApiEndpoint } from '#core/http/openapi/api-endpoint.decorator.ts';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import { type ExportIdParams, ExportIdParamsSchema, type JobExportDto, JobExportSchema } from './dto/job-export.dto.ts';
import { EXPORT_POLL_AFTER_SECONDS, JobExportErrorCode } from './job-exports.constants.ts';
import { exportLocation } from './export-download.service.ts';
import { JobExportsService } from './job-exports.service.ts';

const UNAUTHORIZED = { status: HttpStatus.UNAUTHORIZED, code: AuthErrorCode.USER_ID_REQUIRED };
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, code: JobExportErrorCode.EXPORT_NOT_FOUND };
const UNFINISHED = new Set(['queued', 'processing']);

// Background CSV exports (Asynchronous Request-Reply): request one, poll its
// status, download the file once ready. GET /v1/jobs/export.csv also hands
// out exports when EXPORT_MODE is async or auto.
@ApiTags('exports')
@ApiHeader({
  name: 'X-User-Id',
  required: true,
  description: `Caller id: 1 to ${USER_ID_MAX_LENGTH} printable ASCII characters. Authentication is out of scope.`,
})
@Controller('exports')
@UseGuards(UserIdGuard)
export class ExportsController {
  constructor(
    private readonly exports: JobExportsService,
    private readonly context: RequestContext,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiEndpoint({
    summary: 'Request a CSV export of all jobs',
    description:
      'Prepared in the background. Location points to the status, Retry-After says when to poll. ' +
      'An unfinished export, or one that became ready in the last 5 minutes, is returned instead of a new one.',
    response: { status: HttpStatus.ACCEPTED, schema: JobExportSchema },
    errors: [UNAUTHORIZED, NOT_FOUND],
  })
  async request(@UserId() userId: string, @Res({ passthrough: true }) response: Response): Promise<JobExportDto> {
    const requested = await this.exports.request(userId, this.context.requestId() ?? generateRequestId());
    response.location(exportLocation(requested.export.exportId));
    response.setHeader('Retry-After', String(EXPORT_POLL_AFTER_SECONDS));
    return requested.export;
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'Get an export',
    description:
      'While queued or processing: 200 with Retry-After. Once ready: 303 See Other to the file. ' +
      'Failed, canceled or expired: 200 with that status. Another user’s export is reported as not found.',
    params: ExportIdParamsSchema,
    paramsTakeAnyValue: true,
    response: [
      { status: HttpStatus.OK, schema: JobExportSchema },
      { status: HttpStatus.SEE_OTHER, description: 'Ready: Location is the file.' },
    ],
    errors: [UNAUTHORIZED, NOT_FOUND],
  })
  async get(
    @UserId() userId: string,
    @Param(new ZodValidationPipe(ExportIdParamsSchema)) params: ExportIdParams,
    @Res() response: Response,
  ): Promise<void> {
    const status = await this.exports.get(userId, params.id);
    if (status.status === 'ready') {
      response
        .status(HttpStatus.SEE_OTHER)
        .location(`${exportLocation(status.exportId)}/file`)
        .end();
      return;
    }
    if (UNFINISHED.has(status.status)) {
      response.setHeader('Retry-After', String(EXPORT_POLL_AFTER_SECONDS));
    }
    response.json(status);
  }

  @Get(':id/file')
  @ApiProduces('text/csv')
  @ApiEndpoint({
    summary: 'Download an export’s file',
    description: 'The CSV of a ready export, until it expires.',
    params: ExportIdParamsSchema,
    paramsTakeAnyValue: true,
    response: { status: HttpStatus.OK, description: 'CSV file.' },
    errors: [UNAUTHORIZED, NOT_FOUND, { status: HttpStatus.NOT_FOUND, code: JobExportErrorCode.EXPORT_FILE_NOT_FOUND }],
  })
  async download(
    @UserId() userId: string,
    @Param(new ZodValidationPipe(ExportIdParamsSchema)) params: ExportIdParams,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.exports.openFile(userId, params.id);
    response
      .status(HttpStatus.OK)
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="jobs.csv"');
    // pipeline honours the client's backpressure and closes the file if the client leaves.
    await pipeline(file, response).catch(() => undefined);
  }

  @Delete(':id')
  @ApiEndpoint({
    summary: 'Cancel an export',
    description: 'Stops a queued or processing export. A finished one is returned unchanged.',
    params: ExportIdParamsSchema,
    paramsTakeAnyValue: true,
    response: { status: HttpStatus.OK, schema: JobExportSchema },
    errors: [UNAUTHORIZED, NOT_FOUND],
  })
  cancel(
    @UserId() userId: string,
    @Param(new ZodValidationPipe(ExportIdParamsSchema)) params: ExportIdParams,
  ): Promise<JobExportDto> {
    return this.exports.cancel(userId, params.id);
  }
}
