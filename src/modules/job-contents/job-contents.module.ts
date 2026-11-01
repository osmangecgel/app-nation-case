import { Module } from '@nestjs/common';
import { JobContentsService } from './job-contents.service.ts';

@Module({
  providers: [JobContentsService],
  exports: [JobContentsService],
})
export class JobContentsModule {}
