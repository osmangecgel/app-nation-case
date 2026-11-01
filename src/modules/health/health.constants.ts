// degraded: an optional component (the cache) is down. The API still serves
// every request, only slower, so it must not be taken out of rotation.
export const HealthStatus = {
  OK: 'ok',
  DEGRADED: 'degraded',
  ERROR: 'error',
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export const ComponentStatus = {
  UP: 'up',
  DOWN: 'down',
} as const;
export type ComponentStatus = (typeof ComponentStatus)[keyof typeof ComponentStatus];
