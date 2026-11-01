import { z } from 'zod';
import { OPENAPI_COMPONENTS, toOpenApiParameters, toOpenApiSchema } from './zod-openapi.ts';

describe('toOpenApiSchema', () => {
  beforeEach(() => OPENAPI_COMPONENTS.clear());

  it('keeps descriptions, examples and required fields', () => {
    const schema = z.object({ name: z.string().meta({ description: 'Display name.', example: 'Desk lamp' }) });

    expect(toOpenApiSchema(schema)).toEqual(
      expect.objectContaining({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: 'Display name.', example: 'Desk lamp' } },
      }),
    );
  });

  it('moves named schemas to components and references them (DOC-02)', () => {
    const Item = z.object({ label: z.string() }).meta({ id: 'TestItem' });
    const Order = z.object({ items: z.array(Item) }).meta({ id: 'TestOrder' });

    expect(toOpenApiSchema(Order)).toEqual({ $ref: '#/components/schemas/TestOrder' });
    expect(OPENAPI_COMPONENTS.get('TestOrder')).toEqual(
      expect.objectContaining({
        properties: { items: { type: 'array', items: { $ref: '#/components/schemas/TestItem' } } },
      }),
    );
    expect(OPENAPI_COMPONENTS.has('TestItem')).toBe(true);
  });

  it('documents request schemas by what the client sends, so transforms and defaults are allowed', () => {
    const query = z.object({
      limit: z.coerce.number().default(20),
      cursor: z
        .string()
        .transform((value) => value.length)
        .optional(),
    });

    expect(toOpenApiParameters(query, 'input')).toEqual([
      expect.objectContaining({ name: 'limit', required: false }),
      expect.objectContaining({ name: 'cursor', required: false, schema: expect.objectContaining({ type: 'string' }) }),
    ]);
  });
});
