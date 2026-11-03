import type { MomongaPaths } from '@momonga/foundation';
import type { CostFilter } from '../client/runtime-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';

export type CostOptions = { runId?: string; session?: string; all: boolean; json: boolean; breakdown?: boolean };

export class CostUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostUsageError';
  }
}

const filterOf = (ports: Pick<CliPorts, 'cwd'>, options: CostOptions): CostFilter => {
  const chosen = [options.runId, options.session, options.all ? 'all' : undefined].filter((value) => value !== undefined);
  if (chosen.length > 1) throw new CostUsageError('choose one of a run id, --session and --all');
  if (options.runId !== undefined) return { run: options.runId };
  if (options.session !== undefined) return { session: options.session };
  return options.all ? {} : { cwd: ports.cwd };
};

export const showCost = async (ports: CliPorts, paths: MomongaPaths, options: CostOptions): Promise<number> => {
  const filter = filterOf(ports, options);
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    if (options.breakdown === true) {
      ports.stdout.write(options.json ? `${JSON.stringify(await client.costBreakdown(filter))}\n` : await client.costBreakdownText(filter));
      return 0;
    }
    ports.stdout.write(options.json ? `${JSON.stringify(await client.cost(filter))}\n` : await client.costText(filter));
    return 0;
  } finally {
    await client.close();
  }
};
