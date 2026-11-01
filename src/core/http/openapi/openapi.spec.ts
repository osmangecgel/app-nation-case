import type { OpenAPIObject } from '@nestjs/swagger';
import { collectUndocumented } from './openapi.ts';
import { DOCUMENTED_EXTENSION } from './openapi.constants.ts';

function documentWith(operations: Record<string, object>): OpenAPIObject {
  return { openapi: '3.0.0', info: { title: 'Test', version: '1' }, paths: { '/v1/items': operations } };
}

describe('collectUndocumented', () => {
  it('lists operations without @ApiEndpoint (DOC-01)', () => {
    const document = documentWith({
      get: { responses: {}, [DOCUMENTED_EXTENSION]: true },
      post: { responses: {} },
    });

    expect(collectUndocumented(document)).toEqual(['POST /v1/items']);
  });

  it('removes the internal marker from the document', () => {
    const document = documentWith({ get: { responses: {}, [DOCUMENTED_EXTENSION]: true } });

    collectUndocumented(document);

    expect(JSON.stringify(document)).not.toContain(DOCUMENTED_EXTENSION);
  });
});
