import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { escapeTerminalLine } from '@momonga/protocol';
import type { KeyTable } from '../keys/table.ts';
import type { Subagent } from '../transcript.ts';
import { every } from './timers.ts';
import { displayWidth } from './wrap.ts';
import type { ScreenTimers } from './timers.ts';

const TICK_MS = 1000;
const SHOWN_MARK = '● ';
const NO_MARK = '  ';
const MAIN_LABEL = 'main';

export type ViewTarget = { readonly kind: 'main' } | { readonly kind: 'agent'; readonly runId: string };

export type AgentListLine = { readonly text: string; readonly target: ViewTarget | undefined; readonly chosen: boolean };

export type AgentListFacts = {
  readonly subagents: readonly Subagent[];
  readonly shown: string | undefined;
  readonly focus: number | undefined;
  readonly keys: KeyTable;
  readonly screenReader: boolean;
  readonly columns: number;
  readonly now: number;
  readonly rows: number;
};

export const agentListDrawn = (subagents: readonly Subagent[], shown: string | undefined): boolean => subagents.length > 0 || shown !== undefined;


const doingOf = (subagent: Subagent, now: number, screenReader: boolean): string => {
  const doing = subagent.awaitingApproval ? 'waiting for approval' : (subagent.title ?? 'starting');
  return escapeTerminalLine(screenReader ? `${subagent.agent} · ${doing}` : `${subagent.agent} · ${doing} · ${Math.max(0, Math.floor((now - subagent.startedAt) / 1000))}s`);
};

const sameTarget = (one: ViewTarget, other: ViewTarget): boolean => (one.kind === 'main' ? other.kind === 'main' : other.kind === 'agent' && other.runId === one.runId);

export const chosenIndexOf = (targets: readonly ViewTarget[], focus: ViewTarget | undefined): number => {
  const index = focus === undefined ? -1 : targets.findIndex((target) => sameTarget(target, focus));
  return index === -1 ? 0 : index;
};

const hintOf = (keys: KeyTable, chosen: boolean): string =>
  chosen ? `${keys.keyHint('agents.previous')} or ${keys.keyHint('agents.next')}: move · ${keys.keyHint('agents.open')}: open · typing returns to the input` : `${keys.keyHint('editor.down')} on an empty input: choose a view · ${keys.keyHint('agents.open')}: open`;

export const viewTargetsOf = (subagents: readonly Subagent[]): ViewTarget[] => [{ kind: 'main' }, ...subagents.map((subagent): ViewTarget => ({ kind: 'agent', runId: subagent.runId }))];

const windowOf = (total: number, rows: number, focus: number): { start: number; end: number } => {
  if (focus < rows - 1) return { start: 0, end: rows - 1 };
  if (focus >= total - (rows - 1)) return { start: total - (rows - 1), end: total };
  return { start: focus - (rows - 3), end: focus + 1 };
};

export const agentListLines = ({ subagents, shown, focus, keys, screenReader, columns, now, rows }: AgentListFacts): AgentListLine[] => {
  if (rows <= 0 || !agentListDrawn(subagents, shown)) return [];
  const all = viewTargetsOf(subagents).map((target, index): AgentListLine => {
    const subagent = subagents[index - 1];
    const label = subagent === undefined ? MAIN_LABEL : doingOf(subagent, now, screenReader);
    const isShown = target.kind === 'main' ? shown === undefined : shown === target.runId;
    return { text: screenReader ? `${label}${isShown ? ' (shown)' : ''}${focus === index ? ' (chosen)' : ''}` : `${isShown ? SHOWN_MARK : NO_MARK}${label}`, target, chosen: focus === index };
  });
  const note = (text: string): AgentListLine => ({ text, target: undefined, chosen: false });
  if (all.length <= rows) {
    const hintText = hintOf(keys, focus !== undefined);
    return subagents.length > 0 && rows > all.length && displayWidth(hintText) <= columns ? [...all, note(hintText)] : all;
  }
  if (rows === 1) return all.slice(0, 1);
  if (focus === undefined || rows < 3) return [...all.slice(0, rows - 1), note(`and ${all.length - (rows - 1)} more`)];
  const { start, end } = windowOf(all.length, rows, focus);
  return [...(start > 0 ? [note(`↑ ${start} more above`)] : []), ...all.slice(start, end), ...(end < all.length ? [note(`↓ ${all.length - end} more below`)] : [])];
};

export const agentListRequest = (facts: Omit<AgentListFacts, 'now' | 'rows'>): number => agentListLines({ ...facts, now: 0, rows: Number.MAX_SAFE_INTEGER }).length;

export type AgentListProps = Omit<AgentListFacts, 'now'> & { now(): number; timers: ScreenTimers };

export function AgentList({ now, timers, ...facts }: AgentListProps) {
  const [at, setAt] = useState(now);
  const running = facts.subagents.length > 0 && !facts.screenReader;
  useEffect(() => (running ? every(timers, TICK_MS, () => setAt(now())) : undefined), [running, now, timers]);
  const lines = agentListLines({ ...facts, now: Math.max(at, ...facts.subagents.map((subagent) => subagent.startedAt)) });
  return (
    <>
      {lines.map((line, index) => (
        <Text key={index} dimColor={!line.chosen} inverse={line.chosen} wrap="truncate">
          {line.text}
        </Text>
      ))}
    </>
  );
}
