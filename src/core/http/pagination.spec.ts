import { afterCursor, CursorPaginationQuerySchema, encodeCursor, pageOf } from './pagination.ts';

const ID_A = '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d10';
const ID_B = '0192f3a1-7c4e-7b2a-9d1f-3e5a8b6c2d11';

describe('CursorPaginationQuerySchema (API-07)', () => {
  it('defaults the limit to 20', () => {
    expect(CursorPaginationQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('reads the limit from a query string and decodes the cursor', () => {
    expect(CursorPaginationQuerySchema.parse({ limit: '5', cursor: encodeCursor(ID_A) })).toEqual({
      limit: 5,
      cursor: ID_A,
    });
  });

  it.each([['0'], ['101'], ['abc']])('rejects the limit %s', (limit) => {
    expect(CursorPaginationQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects a cursor it did not create', () => {
    expect(CursorPaginationQuerySchema.safeParse({ cursor: 'not-a-cursor' }).success).toBe(false);
  });
});

describe('pageOf', () => {
  const toItem = (row: { id: string }): string => row.id;

  it('returns the next cursor when one more row than the limit was fetched', () => {
    expect(pageOf([{ id: ID_A }, { id: ID_B }], 1, toItem)).toEqual({
      data: [ID_A],
      pagination: { nextCursor: encodeCursor(ID_A), hasMore: true },
    });
  });

  it('marks the last page', () => {
    expect(pageOf([{ id: ID_A }], 1, toItem)).toEqual({
      data: [ID_A],
      pagination: { nextCursor: null, hasMore: false },
    });
  });
});

describe('afterCursor', () => {
  it('selects rows older than the cursor, or every row without one', () => {
    expect(afterCursor(ID_A)).toEqual({ id: { lt: ID_A } });
    expect(afterCursor(undefined)).toEqual({});
  });
});
