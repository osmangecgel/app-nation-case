import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureHttp } from '#core/http/configure-http.ts';
import { AppModule } from '../../src/app.module.ts';

// The whole application with the same HTTP setup as main.ts, on the test database.
// It listens on a free port: supertest would otherwise start the server for
// every request, and concurrent requests would pile listeners onto it.
export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}
