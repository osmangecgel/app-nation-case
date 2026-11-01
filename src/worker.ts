import { NestFactory } from '@nestjs/core';
import { AppLogger } from '#core/logging/app-logger.ts';
import { WorkerModule } from './worker.module.ts';

async function bootstrap(): Promise<void> {
  // Buffer startup logs until AppLogger is in place, so they use its format.
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  // SIGTERM runs the shutdown hooks: stop consuming, finish or return jobs, disconnect.
  app.enableShutdownHooks();
}
await bootstrap();
