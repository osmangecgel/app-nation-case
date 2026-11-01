import { ExportMode } from '#core/config/env.constants.ts';
import { ExportPlan, planExport } from './export-plan.ts';

describe('planExport', () => {
  it.each([
    [ExportMode.STREAM, false, ExportPlan.STREAM],
    [ExportMode.STREAM, true, ExportPlan.STREAM],
    [ExportMode.ASYNC, false, ExportPlan.BACKGROUND],
    [ExportMode.AUTO, false, ExportPlan.STREAM],
    [ExportMode.AUTO, true, ExportPlan.BACKGROUND],
  ])('%s with a large export %s: %s', async (mode, large, plan) => {
    expect(await planExport(mode, () => Promise.resolve(large))).toBe(plan);
  });

  it('counts the jobs only in auto mode', async () => {
    const count = vi.fn().mockResolvedValue(true);

    await planExport(ExportMode.STREAM, count);
    await planExport(ExportMode.ASYNC, count);

    expect(count).not.toHaveBeenCalled();
  });
});
