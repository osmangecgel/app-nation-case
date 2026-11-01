import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiEndpoint } from '#core/http/openapi/api-endpoint.decorator.ts';
import { type HealthDto, HealthSchema } from './dto/health.dto.ts';
import { HealthStatus } from './health.constants.ts';
import { HealthService } from './health.service.ts';

// Infrastructure probes call /health without an API version (API-06) and
// without a rate limit (API-09, via rateLimited: false).
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiEndpoint({
    summary: 'Check the API and its dependencies',
    description:
      'Used by load balancers and orchestrators. Returns 503 only when the database is unreachable: without ' +
      'the cache the API keeps serving requests, so it reports degraded with 200.',
    response: [
      { status: HttpStatus.OK, schema: HealthSchema, description: 'The API can serve requests (ok or degraded).' },
      { status: HttpStatus.SERVICE_UNAVAILABLE, schema: HealthSchema, description: 'The database is down.' },
    ],
    rateLimited: false,
  })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthDto> {
    const result = await this.health.check();
    if (result.status === HealthStatus.ERROR) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
