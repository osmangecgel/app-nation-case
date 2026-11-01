import { ExportMode } from '#core/config/env.constants.ts';

export const ExportPlan = {
  STREAM: 'stream',
  BACKGROUND: 'background',
} as const;
export type ExportPlan = (typeof ExportPlan)[keyof typeof ExportPlan];

// How GET /v1/jobs/export.csv answers. auto streams small exports at once and
// prepares large ones in the background, so most users never wait while the
// few heavy exports cannot hold a streaming slot for minutes.
export function planExport(mode: ExportMode, hasMoreThanStreamLimit: () => Promise<boolean>): Promise<ExportPlan> {
  switch (mode) {
    case ExportMode.STREAM:
      return Promise.resolve(ExportPlan.STREAM);
    case ExportMode.ASYNC:
      return Promise.resolve(ExportPlan.BACKGROUND);
    case ExportMode.AUTO:
      return hasMoreThanStreamLimit().then((large) => (large ? ExportPlan.BACKGROUND : ExportPlan.STREAM));
  }
}
