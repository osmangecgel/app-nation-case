import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '#core/errors/app-errors.ts';
import { AuthErrorCode, USER_ID_HEADER } from './auth.constants.ts';
import { UserIdSchema } from './user-id.ts';

type RequestWithUser = Request & { userId?: string };

// Rejects requests without a usable X-User-Id with 401 and keeps the id on the
// request for the @UserId() parameter.
@Injectable()
export class UserIdGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const result = UserIdSchema.safeParse(request.header(USER_ID_HEADER));
    if (!result.success) {
      throw new UnauthorizedError(AuthErrorCode.USER_ID_REQUIRED, 'X-User-Id header is missing or invalid.');
    }
    request.userId = result.data;
    return true;
  }
}

// The caller's id; only valid on routes guarded by UserIdGuard.
export const UserId = createParamDecorator((_data: never, context: ExecutionContext): string => {
  const { userId } = context.switchToHttp().getRequest<RequestWithUser>();
  if (!userId) {
    throw new Error('@UserId() used on a route without UserIdGuard.');
  }
  return userId;
});
