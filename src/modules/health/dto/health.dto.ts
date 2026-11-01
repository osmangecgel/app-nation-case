import { z } from 'zod';
import { ComponentStatus, HealthStatus } from '../health.constants.ts';

export type HealthCheckResults = {
  database: boolean;
  cache: boolean;
};

const ComponentStatusSchema = z.enum(ComponentStatus);

export const HealthSchema = z
  .object({
    status: z.enum(HealthStatus).meta({
      description:
        'ok when every component is up; degraded when only the cache is down (requests still succeed); ' +
        'error when the database is down.',
      example: HealthStatus.OK,
    }),
    database: ComponentStatusSchema.meta({ description: 'PostgreSQL.', example: ComponentStatus.UP }),
    cache: ComponentStatusSchema.meta({ description: 'Cache Redis. Optional.', example: ComponentStatus.UP }),
  })
  .meta({ id: 'Health', description: 'Reachability of the API and its dependencies.' });

export type HealthDto = z.infer<typeof HealthSchema>;

function toComponentStatus(healthy: boolean): ComponentStatus {
  return healthy ? ComponentStatus.UP : ComponentStatus.DOWN;
}

function overallStatus(results: HealthCheckResults): HealthStatus {
  if (!results.database) {
    return HealthStatus.ERROR;
  }
  return results.cache ? HealthStatus.OK : HealthStatus.DEGRADED;
}

export function toHealthDto(results: HealthCheckResults): HealthDto {
  return {
    status: overallStatus(results),
    database: toComponentStatus(results.database),
    cache: toComponentStatus(results.cache),
  };
}
