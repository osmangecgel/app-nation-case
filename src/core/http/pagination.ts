import { z } from 'zod';

export const PAGE_LIMIT_DEFAULT = 20;
export const PAGE_LIMIT_MAX = 100;
const INVALID_CURSOR_MESSAGE = 'Cursor is invalid. Use nextCursor from the previous page.';

// The cursor is the base64url-encoded id of the last row on the page. Lists
// are ordered by id, newest first; ids are UUID v7, so the order follows
// creation time to the millisecond (API-07).
export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

const CursorSchema = z.string().transform((cursor, context) => {
  const id = Buffer.from(cursor, 'base64url').toString();
  if (!z.uuid().safeParse(id).success) {
    context.addIssue({ code: 'custom', message: INVALID_CURSOR_MESSAGE });
    return z.NEVER;
  }
  return id;
});

// List endpoints extend this with their own filters (API-08).
export const CursorPaginationQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT)
    .meta({ description: `Rows per page, from 1 to ${PAGE_LIMIT_MAX}.`, example: PAGE_LIMIT_DEFAULT }),
  cursor: CursorSchema.optional().meta({
    description: 'nextCursor from the previous page. Leave empty for the first page.',
  }),
});

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

export const PaginationSchema = z
  .object({
    nextCursor: z
      .string()
      .nullable()
      .meta({ description: 'Send as cursor to get the next page. Null on the last page.' }),
    hasMore: z.boolean().meta({ description: 'True when another page exists.' }),
  })
  .meta({ id: 'Pagination' });

export type Pagination = z.infer<typeof PaginationSchema>;

export function pageSchemaOf<TItem extends z.ZodType>(
  item: TItem,
): z.ZodObject<{ data: z.ZodArray<TItem>; pagination: typeof PaginationSchema }> {
  return z.object({ data: z.array(item), pagination: PaginationSchema });
}

// Rows must be fetched with `take: limit + 1`: the extra row only tells
// whether another page exists and is not returned.
export function pageOf<TRow extends { id: string }, TItem>(
  rows: TRow[],
  limit: number,
  toItem: (row: TRow) => TItem,
): { data: TItem[]; pagination: Pagination } {
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    data: pageRows.map(toItem),
    pagination: { nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null, hasMore },
  };
}

// Prisma filter for the rows after the cursor; combine with orderBy id desc.
export function afterCursor(cursor: string | undefined): { id?: { lt: string } } {
  return cursor ? { id: { lt: cursor } } : {};
}
