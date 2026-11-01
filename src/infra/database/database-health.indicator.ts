import { Injectable } from '@nestjs/common';
import { succeeds } from '#shared/succeeds.ts';
import { PrismaService } from './prisma.service.ts';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly prisma: PrismaService) {}

  isHealthy(): Promise<boolean> {
    return succeeds(async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }
}
