import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { escapeTerminalLine } from '@momonga/protocol';
import type { Subagent } from '../transcript.ts';

const TICK_MS = 1000;

export const subagentLines = (subagents: readonly Subagent[], rows: number, now: number): string[] => {
  if (rows <= 0) return [];
  const shown = subagents.length <= rows ? subagents : subagents.slice(0, rows - 1);
  const lines = shown.map((subagent) => {
    const doing = subagent.awaitingApproval ? 'waiting for approval' : (subagent.title ?? 'starting');
    return escapeTerminalLine(`${subagent.agent} · ${doing} · ${Math.max(0, Math.floor((now - subagent.startedAt) / 1000))}s`);
  });
  return shown.length === subagents.length ? lines : [...lines, `and ${subagents.length - shown.length} more`];
};

export function SubagentRows({ subagents, rows, now }: { subagents: readonly Subagent[]; rows: number; now: () => number }) {
  const [at, setAt] = useState(now);
  const running = subagents.length > 0;
  useEffect(() => {
    if (!running) return undefined;
    const tick = setInterval(() => setAt(now()), TICK_MS);
    return () => clearInterval(tick);
  }, [running, now]);
  return (
    <>
      {subagentLines(subagents, rows, Math.max(at, ...subagents.map((subagent) => subagent.startedAt))).map((line, index) => (
        <Text key={index} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
    </>
  );
}
