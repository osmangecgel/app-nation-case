import { Global, Module } from '@nestjs/common';
import { DatabaseHealthIndicator } from './database-health.indicator.ts';
import { PrismaService } from './prisma.service.ts';

@Global()
@Module({
  providers: [PrismaService, DatabaseHealthIndicator],
  exports: [PrismaService, DatabaseHealthIndicator],
})
export class PrismaModule {}
