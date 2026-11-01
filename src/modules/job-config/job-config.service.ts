import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '#core/config/env.validation.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import { describeError } from '#shared/describe-error.ts';
import { JobConfigLogEvent } from './job-config.constants.ts';
import { type JobRoute, type JobTypeConfig, pickRoute } from './job-route.ts';

export type { JobRoute, JobTypeConfig } from './job-route.ts';

// Limits the worker applies to a job of a given type.
export type JobTypeLimits = {
  code: string;
  maxAttemptCount: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
};

type LoadedConfig = {
  // Types new jobs may be created for: enabled, with at least one usable route.
  acceptable: Map<string, JobTypeConfig>;
  // Every type, enabled or not: a job accepted before its type was disabled
  // is still processed with the limits of its type.
  limits: Map<string, JobTypeLimits>;
  // Provider code to adapter name, for every provider: a job keeps the route
  // it was accepted with.
  adapters: Map<string, string>;
};

const EMPTY_CONFIG: LoadedConfig = { acceptable: new Map(), limits: new Map(), adapters: new Map() };

// Job types, prices, limits and routes come from the database and are kept in
// memory: every request needs them and they change rarely. A failed reload
// keeps the last good configuration.
@Injectable()
export class JobConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobConfigService.name);
  private loaded: LoadedConfig = EMPTY_CONFIG;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.loaded = await this.load();
    this.refreshTimer = setInterval(
      () => void this.refresh(),
      this.config.get('JOB_CONFIG_REFRESH_MS', { infer: true }),
    );
    // Does not keep the process alive on shutdown.
    this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.refreshTimer);
  }

  // Undefined for unknown and disabled types.
  findType(code: string): JobTypeConfig | undefined {
    return this.loaded.acceptable.get(code);
  }

  typeCodes(): string[] {
    return [...this.loaded.acceptable.keys()].toSorted();
  }

  pickRoute(type: JobTypeConfig): JobRoute {
    return pickRoute(type.routes);
  }

  findLimits(jobTypeCode: string): JobTypeLimits | undefined {
    return this.loaded.limits.get(jobTypeCode);
  }

  findAdapter(providerCode: string): string | undefined {
    return this.loaded.adapters.get(providerCode);
  }

  // Reloads now instead of on the next interval; failures keep the last good configuration.
  async refresh(): Promise<void> {
    try {
      this.loaded = await this.load();
    } catch (error) {
      this.logger.warn(JobConfigLogEvent.JOB_CONFIG_REFRESH_FAILED, { reason: describeError(error) });
    }
  }

  private async load(): Promise<LoadedConfig> {
    const [types, providers] = await Promise.all([
      this.prisma.jobType.findMany({
        include: { routes: { where: { is_enabled: true, weight: { gt: 0 }, job_provider: { is_enabled: true } } } },
      }),
      this.prisma.jobProvider.findMany({ select: { code: true, adapter: true } }),
    ]);
    const acceptable = new Map<string, JobTypeConfig>();
    for (const row of types.filter((type) => type.is_enabled)) {
      // A type nobody can serve is left out, so requests for it get 400 instead of waiting forever.
      if (row.routes.length === 0) {
        this.logger.warn(JobConfigLogEvent.JOB_TYPE_WITHOUT_ROUTE, { jobType: row.code });
        continue;
      }
      acceptable.set(row.code, {
        code: row.code,
        cost: row.cost,
        maxInputChars: row.max_input_chars,
        inputFormats: row.input_formats,
        promptVersion: row.prompt_version,
        maxAttemptCount: row.max_attempt_count,
        timeoutMs: row.timeout_ms,
        cacheTtlSeconds: row.cache_ttl_seconds,
        routes: row.routes.map((route) => ({
          providerCode: route.job_provider_code,
          modelVersion: route.model_version,
          weight: route.weight,
        })),
      });
    }
    const limits = new Map(
      types.map((row) => [
        row.code,
        {
          code: row.code,
          maxAttemptCount: row.max_attempt_count,
          timeoutMs: row.timeout_ms,
          cacheTtlSeconds: row.cache_ttl_seconds,
        },
      ]),
    );
    const adapters = new Map(providers.map((provider) => [provider.code, provider.adapter]));
    this.logger.debug(JobConfigLogEvent.JOB_CONFIG_LOADED, { jobTypes: [...acceptable.keys()] });
    return { acceptable, limits, adapters };
  }
}
