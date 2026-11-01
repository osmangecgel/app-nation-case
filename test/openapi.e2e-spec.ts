import { Body, Controller, Get, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { NotFoundError } from '#core/errors/app-errors.ts';
import { configureHttp } from '#core/http/configure-http.ts';
import { ApiEndpoint } from '#core/http/openapi/api-endpoint.decorator.ts';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import { AppModule } from '../src/app.module.ts';

const DocsProbeParamsSchema = z.object({ id: z.uuid().describe('Probe id.') });
const DocsProbeQuerySchema = z.object({ verbose: z.enum(['yes', 'no']).optional().describe('Include details.') });
const DocsProbeBodySchema = z.object({ name: z.string().meta({ description: 'Probe name.', example: 'First' }) });
const DocsProbeSchema = z
  .object({ id: z.uuid(), name: z.string().meta({ example: 'First' }) })
  .meta({ id: 'DocsProbe', description: 'A probe used by the documentation test.' });

@ApiTags('docs-probes')
@Controller('docs-probes')
class DocsProbesController {
  @Post(':id')
  @ApiEndpoint({
    summary: 'Create a docs probe',
    params: DocsProbeParamsSchema,
    query: DocsProbeQuerySchema,
    body: DocsProbeBodySchema,
    response: { status: HttpStatus.CREATED, schema: DocsProbeSchema },
    errors: [{ status: HttpStatus.NOT_FOUND, code: 'DOCS_PROBE_NOT_FOUND' }],
  })
  create(
    @Param(new ZodValidationPipe(DocsProbeParamsSchema)) params: z.infer<typeof DocsProbeParamsSchema>,
    @Query(new ZodValidationPipe(DocsProbeQuerySchema)) _query: z.infer<typeof DocsProbeQuerySchema>,
    @Body(new ZodValidationPipe(DocsProbeBodySchema)) _body: z.infer<typeof DocsProbeBodySchema>,
  ): never {
    throw new NotFoundError('DOCS_PROBE_NOT_FOUND', `Probe ${params.id} was not found.`);
  }

  @Get('undocumented')
  undocumented(): { ok: boolean } {
    return { ok: true };
  }
}

type OpenApiResponse = { description: string; content?: { 'application/json'?: { schema: object } } };
type OpenApiOperation = {
  operationId: string;
  tags: string[];
  summary: string;
  parameters: { name: string; in: string; required: boolean }[];
  requestBody?: { content: { 'application/json': { schema: { properties: object } } } };
  responses: Record<string, OpenApiResponse>;
};
type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, object> };
};

function operationAt(document: OpenApiDocument, path: string, method: string): OpenApiOperation {
  const operation = document.paths[path]?.[method];
  if (!operation) {
    throw new Error(`${method.toUpperCase()} ${path} is not in the document`);
  }
  return operation;
}

describe('API documentation (DOC-01 to DOC-05)', () => {
  let app: NestExpressApplication;
  let document: OpenApiDocument;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [DocsProbesController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttp(app);
    await app.init();
    const response = await request(app.getHttpServer()).get('/docs/openapi.json').expect(HttpStatus.OK);
    document = response.body;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves Swagger UI at /docs', async () => {
    const response = await request(app.getHttpServer()).get('/docs').expect(HttpStatus.OK);

    expect(response.text).toContain('swagger');
  });

  it('documents /health without a version, rate limit response or problem body for 503', () => {
    const operation = document.paths['/health']?.get;

    expect(operation).toEqual(expect.objectContaining({ operationId: 'health.check', tags: ['health'] }));
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', '500', '503']);
  });

  it('names operations as <controller>.<method>', () => {
    expect(document.paths['/v1/docs-probes/{id}']?.post?.operationId).toBe('docsProbes.create');
  });

  it('documents path and query parameters and the request body from zod schemas', () => {
    const operation = document.paths['/v1/docs-probes/{id}']?.post;

    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'verbose', in: 'query', required: false }),
      ]),
    );
    expect(operation?.requestBody?.content['application/json'].schema.properties).toHaveProperty('name');
  });

  it('documents declared and automatic error responses with the problem schema (DOC-04)', () => {
    const { responses } = operationAt(document, '/v1/docs-probes/{id}', 'post');

    expect(Object.keys(responses).sort()).toEqual(['201', '400', '404', '413', '429', '500']);
    expect(responses['400']?.description).toContain('VALIDATION_FAILED');
    expect(responses['400']?.description).toContain('INVALID_JSON');
    expect(responses['413']?.description).toContain('PAYLOAD_TOO_LARGE');
    expect(responses['404']).toEqual(
      expect.objectContaining({
        description: expect.stringContaining('DOCS_PROBE_NOT_FOUND'),
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } },
      }),
    );
  });

  it('puts named schemas under components', () => {
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['ProblemDetails', 'DocsProbe', 'Health']),
    );
  });
});
