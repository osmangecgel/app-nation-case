import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { NodeEnv } from '#core/config/env.constants.ts';
import type { Env } from '#core/config/env.validation.ts';
import { type Prisma, PrismaClient } from '#generated/prisma/client.ts';

const DATABASE_CONNECTION_TIMEOUT_MS = 5000;
const QUERY_LOG_EVENT = 'DATABASE_QUERY';

type QueryEventOptions = Prisma.PrismaClientOptions & {
  log: { emit: 'event'; level: 'query' }[];
};

@Injectable()
export class PrismaService extends PrismaClient<QueryEventOptions> implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    const logQueries = config.get('LOG_DB_QUERIES', { infer: true });
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        // Fail instead of waiting forever when the database does not accept connections.
        connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
      }),
      log: logQueries ? [{ emit: 'event', level: 'query' } as const] : [],
    });
    if (logQueries) {
      // LOG-08: parameters may contain personal data, so only in development.
      const logParams = config.get('NODE_ENV', { infer: true }) === NodeEnv.DEVELOPMENT;
      this.$on('query', (event) => this.logQuery(event, logParams));
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // Closed in the last shutdown step, after beforeApplicationShutdown: the
  // worker's grace period still settles jobs with this connection.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  private logQuery(event: Prisma.QueryEvent, logParams: boolean): void {
    this.logger.log(QUERY_LOG_EVENT, {
      query: event.query,
      durationMs: Math.round(event.duration),
      ...(logParams ? { params: event.params } : {}),
    });
  }
}
