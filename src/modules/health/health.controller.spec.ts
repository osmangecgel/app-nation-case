import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { ComponentStatus, HealthStatus } from './health.constants.ts';
import { HealthController } from './health.controller.ts';
import { HealthService } from './health.service.ts';

async function createController(status: HealthStatus): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: HealthService,
        useValue: {
          check: vi.fn().mockResolvedValue({
            status,
            database: ComponentStatus.UP,
            cache: status === HealthStatus.OK ? ComponentStatus.UP : ComponentStatus.DOWN,
          }),
        },
      },
    ],
  }).compile();
  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  it('returns 503 when a required component is down', async () => {
    const controller = await createController(HealthStatus.ERROR);
    const response = { status: vi.fn() };

    await controller.check(response as never as Response);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('keeps the default 200 when only the cache is down', async () => {
    const controller = await createController(HealthStatus.DEGRADED);
    const response = { status: vi.fn() };

    await controller.check(response as never as Response);

    expect(response.status).not.toHaveBeenCalled();
  });

  it('keeps the default 200 when every component is up', async () => {
    const controller = await createController(HealthStatus.OK);
    const response = { status: vi.fn() };

    await controller.check(response as never as Response);

    expect(response.status).not.toHaveBeenCalled();
  });
});
