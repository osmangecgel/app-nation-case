export type JobRoute = {
  providerCode: string;
  modelVersion: string;
  weight: number;
};

export type JobTypeConfig = {
  code: string;
  cost: number;
  maxInputChars: number;
  inputFormats: string[];
  promptVersion: string;
  maxAttemptCount: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  // Enabled routes with a positive weight to an enabled provider; never empty.
  routes: JobRoute[];
};

// Picks a route in proportion to its weight, e.g. 90/10 to try a new model on a
// tenth of new jobs. `random` is in [0, 1).
export function pickRoute(routes: JobRoute[], random: number = Math.random()): JobRoute {
  const total = routes.reduce((sum, route) => sum + route.weight, 0);
  let point = random * total;
  for (const route of routes) {
    point -= route.weight;
    if (point < 0) {
      return route;
    }
  }
  return routes[routes.length - 1];
}
