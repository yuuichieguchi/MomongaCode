import path from 'node:path';
import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { TrustItem } from '@momonga/protocol';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { UsageError } from '../usage-error.ts';
import type { TrustView } from '../client/views.ts';

export const TRUST_DECISIONS = ['trusted', 'untrusted'] as const;

type TrustDecision = (typeof TRUST_DECISIONS)[number];

export type TrustOptions = { folder?: string; set?: string; clear?: boolean };

const isDecision = (value: string): value is TrustDecision => (TRUST_DECISIONS as readonly string[]).includes(value);

const decisionOf = (options: TrustOptions): TrustDecision | 'clear' | 'show' => {
  if (options.set !== undefined && options.clear === true) throw new UsageError('momonga trust takes --set or --clear, not both');
  if (options.clear === true) return 'clear';
  if (options.set === undefined) return 'show';
  if (!isDecision(options.set)) throw new UsageError(`momonga trust --set takes ${TRUST_DECISIONS.join(' or ')}, not ${JSON.stringify(options.set)}`);
  return options.set;
};

const itemName = (item: TrustItem): string => {
  if (item.kind === 'hook') return `hook ${item.event}`;
  if (item.kind === 'mandate') return 'mandate';
  if (item.kind === 'mcp') return `MCP server ${item.name}`;
  return `agent ${item.name}`;
};

const viewLines = (view: TrustView): string[] => {
  const decided = view.decision === null ? 'not decided' : view.decision;
  const inherited = view.inheritedFrom === undefined ? '' : ` (from ${escapeTerminalLine(view.inheritedFrom)})`;
  const folder = escapeTerminalLine(view.path);
  return [`${folder}: ${decided}${inherited}`, ...(view.decision === null ? [`decide it with momonga trust ${folder} --set trusted, or --set untrusted`] : [])];
};

export const trustFolder = async (ports: CliPorts, paths: MomongaPaths, options: TrustOptions): Promise<number> => {
  const decision = decisionOf(options);
  const folder = path.resolve(ports.cwd, options.folder ?? '.');
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    if (decision === 'clear') {
      const current = await client.trust(folder);
      await client.clearTrust(current.path);
      ports.stdout.write(`${escapeTerminalLine(current.path)}: not decided\n`);
      return 0;
    }
    if (decision !== 'show') {
      ports.stdout.write(`${viewLines(await client.setTrust(folder, decision)).join('\n')}\n`);
      return 0;
    }
    const view = await client.trust(folder);
    const { items, refused } = await client.trustItems(view.path);
    const lines = [
      ...viewLines(view),
      ...items.map((item) => `  waiting for approval: ${escapeTerminalLine(itemName(item))} from ${escapeTerminalLine(item.source)} (${item.change.kind})`),
      ...refused.map((reason) => `  refused: ${escapeTerminalLine(reason)}`),
    ];
    ports.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
