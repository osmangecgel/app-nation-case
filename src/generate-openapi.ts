import { readFile, writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { configureVersioning } from '#core/http/configure-http.ts';
import { createOpenApiDocument } from '#core/http/openapi/openapi.ts';
import { OPENAPI_OUTPUT_FILE } from '#core/http/openapi/openapi.constants.ts';
import { AppModule } from './app.module.ts';

const CHECK_FLAG = '--check';

// DOC-06: writes docs/api/openapi.json, or with --check fails when the file is
// out of date or an endpoint has no @ApiEndpoint. Preview mode builds the
// routes without starting providers, so no database or Redis is needed.
async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  configureVersioning(app);
  const { document, undocumented } = createOpenApiDocument(app);
  await app.close();

  if (undocumented.length > 0) {
    process.stderr.write(`Endpoints without @ApiEndpoint (DOC-01):\n${undocumented.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (!process.argv.includes(CHECK_FLAG)) {
    await writeFile(OPENAPI_OUTPUT_FILE, content);
    return;
  }
  const committed = await readFile(OPENAPI_OUTPUT_FILE, 'utf8').catch(() => '');
  if (committed !== content) {
    process.stderr.write(`${OPENAPI_OUTPUT_FILE} is out of date. Run npm run docs:generate and commit it.\n`);
    process.exitCode = 1;
  }
}

await generate();
