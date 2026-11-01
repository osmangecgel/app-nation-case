import { testPrisma } from './test-prisma.ts';

export type CreditState = {
  balance: number;
  reserved: number;
  ledgerBalance: number;
  ledgerReserved: number;
};

// The user's counters next to the same values rebuilt from the ledger:
//   balance  = grant - reserve + release
//   reserved = reserve - capture - release
export async function creditState(userId: string): Promise<CreditState> {
  const user = await testPrisma.user.findUniqueOrThrow({ where: { id: userId } });
  const sums = await testPrisma.userCreditLedgerEntry.groupBy({
    by: ['entry_type'],
    where: { user_id: userId },
    _sum: { amount: true },
  });
  const sum = (type: string): number => sums.find((row) => row.entry_type === type)?._sum.amount ?? 0;
  return {
    balance: user.balance,
    reserved: user.reserved,
    ledgerBalance: sum('grant') - sum('reserve') + sum('release'),
    ledgerReserved: sum('reserve') - sum('capture') - sum('release'),
  };
}
