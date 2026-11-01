import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '#core/http/openapi/api-endpoint.decorator.ts';
import { ZodValidationPipe } from '#core/validation/zod-validation.pipe.ts';
import {
  type GrantCreditsDto,
  GrantCreditsSchema,
  type UserCreditsDto,
  UserCreditsSchema,
  type UserIdParams,
  UserIdParamsSchema,
} from './dto/user-credits.dto.ts';
import { UserErrorCode } from './users.constants.ts';
import { UsersService } from './users.service.ts';

// Internal endpoints for adding and checking credits. In production they would
// be reachable only from the internal network (the payment system); here they
// are open, which the case allows.
@ApiTags('internal')
@Controller({ path: 'internal/users', version: VERSION_NEUTRAL })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post(':id/credits')
  @HttpCode(HttpStatus.OK)
  @ApiEndpoint({
    summary: 'Add credits to a user',
    description: 'Creates the user on the first grant. Writes a grant entry to the credit ledger.',
    params: UserIdParamsSchema,
    body: GrantCreditsSchema,
    response: { status: HttpStatus.OK, schema: UserCreditsSchema },
    errors: [{ status: HttpStatus.UNPROCESSABLE_ENTITY, code: UserErrorCode.BALANCE_LIMIT_EXCEEDED }],
  })
  grant(
    @Param(new ZodValidationPipe(UserIdParamsSchema)) params: UserIdParams,
    @Body(new ZodValidationPipe(GrantCreditsSchema)) body: GrantCreditsDto,
  ): Promise<UserCreditsDto> {
    return this.users.grantCredits(params.id, body.amount);
  }

  @Get(':id/credits')
  @ApiEndpoint({
    summary: "Get a user's credits",
    description: 'A user who never received credits has zero balance.',
    params: UserIdParamsSchema,
    response: { status: HttpStatus.OK, schema: UserCreditsSchema },
  })
  get(@Param(new ZodValidationPipe(UserIdParamsSchema)) params: UserIdParams): Promise<UserCreditsDto> {
    return this.users.getCredits(params.id);
  }
}
