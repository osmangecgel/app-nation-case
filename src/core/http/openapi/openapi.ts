import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import {
  API_DESCRIPTION,
  API_DOCS_JSON_PATH,
  API_DOCS_PATH,
  API_TITLE,
  DOCUMENTED_EXTENSION,
} from './openapi.constants.ts';
import { OPENAPI_COMPONENTS } from './zod-openapi.ts';

const CONTROLLER_SUFFIX = /Controller$/;

// DOC-01: operationId is <controller>.<method>, e.g. ProductsController.findOne -> products.findOne.
function operationId(controllerKey: string, methodKey: string): string {
  const controller = controllerKey.replace(CONTROLLER_SUFFIX, '');
  return `${controller.charAt(0).toLowerCase()}${controller.slice(1)}.${methodKey}`;
}

// Lists operations without @ApiEndpoint and removes the marker from the rest.
export function collectUndocumented(document: OpenAPIObject): string[] {
  const undocumented: string[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (typeof operation !== 'object' || operation === null || !('responses' in operation)) {
        continue;
      }
      if (!(DOCUMENTED_EXTENSION in operation)) {
        undocumented.push(`${method.toUpperCase()} ${path}`);
      }
      Reflect.deleteProperty(operation, DOCUMENTED_EXTENSION);
    }
  }
  return undocumented;
}

export type OpenApiResult = { document: OpenAPIObject; undocumented: string[] };

export function createOpenApiDocument(app: INestApplication): OpenApiResult {
  const config = new DocumentBuilder().setTitle(API_TITLE).setDescription(API_DESCRIPTION).build();
  const document = SwaggerModule.createDocument(app, config, { operationIdFactory: operationId });
  const undocumented = collectUndocumented(document);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...Object.fromEntries(OPENAPI_COMPONENTS) },
  };
  return { document, undocumented };
}

// DOC-05: Swagger UI at /docs and the JSON at /docs/openapi.json, in every environment.
export function setupApiDocs(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup(API_DOCS_PATH, app, document, { jsonDocumentUrl: API_DOCS_JSON_PATH });
}
