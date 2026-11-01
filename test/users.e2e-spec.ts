import { HttpStatus } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { creditState } from './support/credits.ts';
import { createTestApp } from './support/test-app.ts';
import { testPrisma } from './support/test-prisma.ts';

describe('/internal/users/:id/credits', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  it('creates the user on the first grant and records it in the ledger', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/users/user-1/credits')
      .send({ amount: 10 })
      .expect(HttpStatus.OK);

    expect(response.body).toEqual({ userId: 'user-1', balance: 10, reserved: 0 });
    expect(await creditState('user-1')).toEqual({ balance: 10, reserved: 0, ledgerBalance: 10, ledgerReserved: 0 });
  });

  it('adds to the balance of an existing user', async () => {
    await request(app.getHttpServer()).post('/internal/users/user-1/credits').send({ amount: 10 });

    const response = await request(app.getHttpServer())
      .post('/internal/users/user-1/credits')
      .send({ amount: 5 })
      .expect(HttpStatus.OK);

    expect(response.body.balance).toBe(15);
    expect(await testPrisma.userCreditLedgerEntry.count({ where: { user_id: 'user-1' } })).toBe(2);
  });

  it.each([
    ['zero', { amount: 0 }],
    ['a fraction', { amount: 1.5 }],
    ['missing', {}],
  ])('rejects an amount that is %s with 400', async (_case, body) => {
    const response = await request(app.getHttpServer())
      .post('/internal/users/user-1/credits')
      .send(body)
      .expect(HttpStatus.BAD_REQUEST);

    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a grant that would take the balance past the largest storable amount, and changes nothing', async () => {
    await request(app.getHttpServer())
      .post('/internal/users/user-1/credits')
      .send({ amount: 10 })
      .expect(HttpStatus.OK);
    // Reaching the limit through the API would take 2,148 grants of the maximum amount.
    await testPrisma.$executeRaw`UPDATE users SET balance = 2147483000 WHERE id = 'user-1'`;

    const response = await request(app.getHttpServer())
      .post('/internal/users/user-1/credits')
      .send({ amount: 1000 })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);

    expect(response.body).toMatchObject({ code: 'BALANCE_LIMIT_EXCEEDED', error: 'balance_limit_exceeded' });
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: 'user-1' } })).balance).toBe(2147483000);
    expect(await testPrisma.userCreditLedgerEntry.count({ where: { user_id: 'user-1' } })).toBe(1);
  });

  it('reports zero credits for a user who never received any', async () => {
    const response = await request(app.getHttpServer()).get('/internal/users/nobody/credits').expect(HttpStatus.OK);

    expect(response.body).toEqual({ userId: 'nobody', balance: 0, reserved: 0 });
  });
});
