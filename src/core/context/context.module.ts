import { Global, Module } from '@nestjs/common';
import { RequestContext } from './request-context.ts';

@Global()
@Module({
  providers: [RequestContext],
  exports: [RequestContext],
})
export class ContextModule {}
