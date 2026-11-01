import { Injectable, Logger } from '@nestjs/common';
import {
  type AppError,
  BusinessRuleError,
  PaymentRequiredError,
  TooManyRequestsError,
} from '#core/errors/app-errors.ts';
import { PrismaService } from '#infra/database/prisma.service.ts';
import type { Prisma } from '#generated/prisma/client.ts';
import { uuidV7 } from '#shared/uuid-v7.ts';
import { toUserCreditsDto, type UserCreditsDto } from './dto/user-credits.dto.ts';
import { MAX_USER_CREDITS, UserErrorCode, UserLogEvent } from './users.constants.ts';

export type CreditReservation = {
  userId: string;
  jobId: string;
  cost: number;
  maxActiveJobs: number;
};

// Settling a reservation: capture when the job succeeded, release when it failed.
// A job can be settled at most once: a second capture or release of the same job
// violates user_credit_ledger_settle_once_idx and rolls the transaction back.
export type CreditSettlement = {
  userId: string;
  jobId: string;
  cost: number;
};

type CreditsRow = { id: string; balance: number; reserved: number };

const insufficientCredits = (): AppError =>
  new PaymentRequiredError(UserErrorCode.INSUFFICIENT_CREDITS, 'Not enough credits for this job.');

// Owns users and user_credit_ledger. Every balance change and its ledger entry
// are written by one statement, so they commit or roll back together.
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Creates the user on its first grant. Refused, with nothing written, when it
  // would take the user's credits past what the columns can hold.
  async grantCredits(userId: string, amount: number): Promise<UserCreditsDto> {
    const [row] = await this.prisma.$queryRaw<CreditsRow[]>`
      WITH granted AS (
        INSERT INTO users (id, balance, updated_at) VALUES (${userId}, ${amount}::int, now())
        ON CONFLICT (id) DO UPDATE SET balance = users.balance + EXCLUDED.balance, updated_at = now()
          WHERE users.balance::bigint + users.reserved + EXCLUDED.balance <= ${MAX_USER_CREDITS}::bigint
        RETURNING id, balance, reserved
      ), entry AS (
        INSERT INTO user_credit_ledger (id, user_id, entry_type, amount)
        SELECT ${uuidV7()}::uuid, id, 'grant'::user_credit_entry_type, ${amount}::int FROM granted
      )
      SELECT id, balance, reserved FROM granted`;
    if (!row) {
      throw new BusinessRuleError(
        UserErrorCode.BALANCE_LIMIT_EXCEEDED,
        `The grant would take the user's credits past ${MAX_USER_CREDITS}.`,
      );
    }
    this.logger.log(UserLogEvent.CREDITS_GRANTED, { userId, amount });
    return toUserCreditsDto(row);
  }

  // A user without a grant has no row yet; to the caller that is zero credits.
  async getCredits(userId: string): Promise<UserCreditsDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, balance: true, reserved: true },
    });
    return toUserCreditsDto(user ?? { id: userId, balance: 0, reserved: 0 });
  }

  // A user who never received credits cannot create a job; checked before any
  // row that references the user is written.
  async requireUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      throw insufficientCredits();
    }
  }

  // Moves the cost from balance to reserved and records it, in one statement.
  // The condition and the change are a single UPDATE, so two concurrent
  // reservations cannot both pass the balance check: the second waits on the
  // row lock and PostgreSQL re-evaluates its WHERE against the new balance.
  // Callers run this last in their transaction to hold the lock briefly.
  async reserveCredits(tx: Prisma.TransactionClient, reservation: CreditReservation): Promise<void> {
    const { userId, jobId, cost, maxActiveJobs } = reservation;
    const entries = await tx.$queryRaw<{ id: string }[]>`
      WITH reserved AS (
        UPDATE users
           SET balance = balance - ${cost}::int,
               reserved = reserved + ${cost}::int,
               active_job_count = active_job_count + 1,
               updated_at = now()
         WHERE id = ${userId} AND balance >= ${cost}::int AND active_job_count < ${maxActiveJobs}::int
        RETURNING id
      )
      INSERT INTO user_credit_ledger (id, user_id, job_id, entry_type, amount)
      SELECT ${uuidV7()}::uuid, id, ${jobId}::uuid, 'reserve'::user_credit_entry_type, ${cost}::int FROM reserved
      RETURNING id`;
    if (entries.length === 0) {
      throw await this.reservationError(tx, userId, cost);
    }
  }

  // The job succeeded: the reserved credits are spent.
  async captureCredits(tx: Prisma.TransactionClient, settlement: CreditSettlement): Promise<void> {
    await tx.$executeRaw`
      WITH settled AS (
        UPDATE users
           SET reserved = reserved - ${settlement.cost}::int,
               active_job_count = active_job_count - 1,
               updated_at = now()
         WHERE id = ${settlement.userId}
        RETURNING id
      )
      INSERT INTO user_credit_ledger (id, user_id, job_id, entry_type, amount)
      SELECT ${uuidV7()}::uuid, id, ${settlement.jobId}::uuid, 'capture'::user_credit_entry_type, ${settlement.cost}::int
        FROM settled`;
  }

  // The job failed for good: the reserved credits go back to the balance.
  async releaseCredits(tx: Prisma.TransactionClient, settlement: CreditSettlement): Promise<void> {
    await tx.$executeRaw`
      WITH settled AS (
        UPDATE users
           SET balance = balance + ${settlement.cost}::int,
               reserved = reserved - ${settlement.cost}::int,
               active_job_count = active_job_count - 1,
               updated_at = now()
         WHERE id = ${settlement.userId}
        RETURNING id
      )
      INSERT INTO user_credit_ledger (id, user_id, job_id, entry_type, amount)
      SELECT ${uuidV7()}::uuid, id, ${settlement.jobId}::uuid, 'release'::user_credit_entry_type, ${settlement.cost}::int
        FROM settled`;
  }

  private async reservationError(tx: Prisma.TransactionClient, userId: string, cost: number): Promise<AppError> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { balance: true } });
    if (!user || user.balance < cost) {
      return insufficientCredits();
    }
    return new TooManyRequestsError(
      UserErrorCode.TOO_MANY_ACTIVE_JOBS,
      'Too many unfinished jobs. Try again when some have finished.',
    );
  }
}
