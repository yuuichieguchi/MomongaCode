import { InvalidArgumentError } from 'commander';
import type { MomongaPaths } from '@momonga/foundation';
import type { GoverningEnforcement, GoverningKind } from '@momonga/protocol';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { formatRuleAdded, formatRuleHistory, formatRuleList } from '../rule/format.ts';
import { connectRuntime } from '../run/open-session.ts';

export type RuleAddOptions = {
  kind: GoverningKind;
  user: boolean;
  paths: readonly string[];
  enforcement: GoverningEnforcement | null;
  supersedes: readonly string[];
  until?: number;
  json: boolean;
};

const withRuntime = async <T>(ports: CliPorts, paths: MomongaPaths, use: (client: ReturnType<typeof connectRuntime>) => Promise<T>): Promise<T> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
};

export const ruleAdd = async (ports: CliPorts, paths: MomongaPaths, target: string, text: string, options: RuleAddOptions): Promise<number> => {
  if (options.user && options.paths.length > 0) throw new InvalidArgumentError('--path applies to a rule of this folder, so it cannot be combined with --user');
  return withRuntime(ports, paths, async (client) => {
    const response = await client.addRule({
      kind: options.kind,
      target,
      text,
      scope: options.user ? { level: 'user' } : { level: 'project', project: ports.cwd, paths: [...options.paths] },
      supersedes: [...options.supersedes],
      enforcement: options.enforcement,
      ...(options.until === undefined ? {} : { validUntil: options.until }),
    });
    ports.stdout.write(`${options.json ? JSON.stringify(response) : formatRuleAdded(response)}\n`);
    return 0;
  });
};

export const ruleList = (ports: CliPorts, paths: MomongaPaths, json: boolean): Promise<number> =>
  withRuntime(ports, paths, async (client) => {
    const facts = await client.rules(ports.cwd);
    ports.stdout.write(`${json ? JSON.stringify(facts) : formatRuleList(facts)}\n`);
    return 0;
  });

export const ruleRetire = (ports: CliPorts, paths: MomongaPaths, id: string): Promise<number> =>
  withRuntime(ports, paths, async (client) => {
    const fact = await client.retireRule(id);
    ports.stdout.write(`retired rule ${fact.id}\n`);
    return 0;
  });

export const ruleHistory = (ports: CliPorts, paths: MomongaPaths, id: string, json: boolean): Promise<number> =>
  withRuntime(ports, paths, async (client) => {
    const facts = await client.ruleHistory(id);
    ports.stdout.write(`${json ? JSON.stringify(facts) : formatRuleHistory(facts)}\n`);
    return 0;
  });
