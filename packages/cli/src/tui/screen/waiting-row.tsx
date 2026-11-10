import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { escapeTerminalLine } from '@momonga/protocol';
import { every } from './timers.ts';
import type { ScreenTimers } from './timers.ts';

export type WaitingPhase = { text: string; startedAt: number };

export type CancelKey = 'esc' | 'ctrl+c';

export type Waiting = { phase: WaitingPhase; cancelKey: CancelKey | undefined };

export type WaitingFacts = {
  startingSince: number | undefined;
  prompting: boolean;
  reconnectingSince: number | undefined;
  run: WaitingPhase | undefined;
  command: WaitingPhase | undefined;
  measuringSince: number | undefined;
  panelOwnsEscape: boolean;
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const SPINNER_MS = 100;

export const STARTING_TEXT = 'starting the momonga daemon';
export const RECONNECTING_TEXT = 'reconnecting to the daemon';
export const MEASURING_TEXT = 'measuring this model (once per model and OS build)';

export const commandPhaseText = (label: string): string => `running ${label}`;

export const waitingOf = (facts: WaitingFacts): Waiting | undefined => {
  if (facts.startingSince !== undefined) return { phase: { text: STARTING_TEXT, startedAt: facts.startingSince }, cancelKey: 'ctrl+c' };
  if (facts.prompting) return undefined;
  const cancelKey: CancelKey = facts.panelOwnsEscape ? 'ctrl+c' : 'esc';
  if (facts.reconnectingSince !== undefined) return { phase: { text: RECONNECTING_TEXT, startedAt: facts.reconnectingSince }, cancelKey };
  if (facts.run !== undefined) return { phase: facts.run, cancelKey };
  if (facts.command !== undefined) return { phase: facts.command, cancelKey };
  if (facts.measuringSince !== undefined) return { phase: { text: MEASURING_TEXT, startedAt: facts.measuringSince }, cancelKey: undefined };
  return undefined;
};

export const waitingRowText = (waiting: Waiting, tick: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - waiting.phase.startedAt) / 1000));
  const cancel = waiting.cancelKey === undefined ? '' : ` · ${waiting.cancelKey} to cancel`;
  return `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} ${escapeTerminalLine(waiting.phase.text)} ${seconds}s${cancel}`;
};

export type WaitingRowProps = { waiting: Waiting; now(): number; timers: ScreenTimers };

export function WaitingRow({ waiting, now, timers }: WaitingRowProps) {
  const [shown, setShown] = useState(() => ({ tick: 0, at: now() }));
  useEffect(() => every(timers, SPINNER_MS, () => setShown((before) => ({ tick: before.tick + 1, at: now() }))), [timers, now]);
  return (
    <Text dimColor wrap="truncate">
      {waitingRowText(waiting, shown.tick, shown.at)}
    </Text>
  );
}
