import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

const ZOD_DEFINITIONS_PREFIX = '"#/definitions/';
const COMPONENTS_PREFIX = '"#/components/schemas/';

type ConvertedSchema = (SchemaObject | ReferenceObject) & { definitions?: Record<string, SchemaObject> };

// Schemas named with .meta({ id }), collected while decorators run and added
// to the document's components by createOpenApiDocument (DOC-02).
export const OPENAPI_COMPONENTS = new Map<string, SchemaObject>();

// Requests are documented by what the client sends ('input'), so defaults and
// transforms such as cursor decoding are allowed; responses by what it receives.
type SchemaSide = 'input' | 'output';

// zod 4 converts schemas to OpenAPI itself. Named schemas come back under
// `definitions`; OpenAPI expects them under `components/schemas`.
export function toOpenApiSchema(schema: z.ZodType, io: SchemaSide = 'output'): SchemaObject | ReferenceObject {
  const json = JSON.stringify(z.toJSONSchema(schema, { target: 'openapi-3.0', io })).replaceAll(
    ZOD_DEFINITIONS_PREFIX,
    COMPONENTS_PREFIX,
  );
  const { definitions = {}, ...root }: ConvertedSchema = JSON.parse(json);
  for (const [id, definition] of Object.entries(definitions)) {
    OPENAPI_COMPONENTS.set(id, definition);
  }
  return root;
}

// Query and path parameters are documented one by one, so the object schema
// is split into its properties.
export function toOpenApiParameters(
  schema: z.ZodObject,
  io: SchemaSide = 'output',
): { name: string; required: boolean; schema: SchemaObject | ReferenceObject }[] {
  const converted = toOpenApiSchema(schema, io);
  const { properties = {}, required = [] }: SchemaObject = '$ref' in converted ? {} : converted;
  return Object.entries(properties).map(([name, property]) => ({
    name,
    required: required.includes(name),
    schema: property,
  }));
}
