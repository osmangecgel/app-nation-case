import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from '#core/config/env.validation.ts';
import { configureHttp } from '#core/http/configure-http.ts';
import { AppLogger } from '#core/logging/app-logger.ts';
import { AppModule } from './app.module.ts';

async function bootstrap(): Promise<void> {
  // Buffer startup logs until AppLogger is in place, so they use its format.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  configureHttp(app);
  app.enableShutdownHooks();
  const config = app.get(ConfigService<Env, true>);
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();
