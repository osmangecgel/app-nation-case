import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedError } from '#core/errors/app-errors.ts';
import { UserIdGuard } from './user-id.guard.ts';

function contextWith(userIdHeader: string | undefined): { context: ExecutionContext; request: { userId?: string } } {
  const request = { userId: undefined, header: (): string | undefined => userIdHeader };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as never as ExecutionContext;
  return { context, request };
}

describe('UserIdGuard', () => {
  const guard = new UserIdGuard();

  it('keeps a valid user id on the request', () => {
    const { context, request } = contextWith('user-1');

    expect(guard.canActivate(context)).toBe(true);
    expect(request.userId).toBe('user-1');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'u'.repeat(65)],
    ['with spaces', 'user 1'],
  ])('rejects a %s header with 401', (_case, header) => {
    expect(() => guard.canActivate(contextWith(header).context)).toThrow(UnauthorizedError);
  });
});
