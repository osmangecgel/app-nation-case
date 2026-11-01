import { z } from 'zod';
import { UserIdSchema } from '#core/auth/user-id.ts';
import { MAX_GRANT_AMOUNT } from '../users.constants.ts';

export const UserIdParamsSchema = z.strictObject({ id: UserIdSchema });

export type UserIdParams = z.infer<typeof UserIdParamsSchema>;

export const GrantCreditsSchema = z
  .strictObject({
    amount: z
      .number()
      .int()
      .min(1)
      .max(MAX_GRANT_AMOUNT)
      .meta({ description: 'Credits to add to the balance.', example: 10 }),
  })
  .meta({ id: 'GrantCredits' });

export type GrantCreditsDto = z.infer<typeof GrantCreditsSchema>;

export const UserCreditsSchema = z
  .object({
    userId: UserIdSchema,
    balance: z.number().int().meta({ description: 'Credits that can be spent now.', example: 7 }),
    reserved: z
      .number()
      .int()
      .meta({ description: 'Credits held by unfinished jobs; captured or released when they finish.', example: 3 }),
  })
  .meta({ id: 'UserCredits' });

export type UserCreditsDto = z.infer<typeof UserCreditsSchema>;

export function toUserCreditsDto(row: { id: string; balance: number; reserved: number }): UserCreditsDto {
  return { userId: row.id, balance: row.balance, reserved: row.reserved };
}
