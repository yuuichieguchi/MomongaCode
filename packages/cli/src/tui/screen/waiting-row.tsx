import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { escapeTerminalLine, measuringSkipOf, measuringStepOf } from '@momonga/protocol';
import type { Measuring } from '@momonga/protocol';
import type { ActionId, KeyTable } from '../keys/table.ts';
import { SPINNER_FRAMES, SPINNER_MS, STATIC_MARK } from '../terminal/marks.ts';
import { every } from './timers.ts';
import type { ScreenTimers } from './timers.ts';

export type WaitingPhase = { text: string; startedAt: number; detail?: string };

export type CancelKey = Extract<ActionId, 'run.stop' | 'prompt.interrupt'>;

export type Waiting = { phase: WaitingPhase; cancelKey: CancelKey | undefined };

export type Loading = { done: number; total: number; startedAt: number };

export type WaitingFacts = {
  startingSince: number | undefined;
  prompting: boolean;
  reconnectingSince: number | undefined;
  run: WaitingPhase | undefined;
  command: WaitingPhase | undefined;
  measuring: { since: number; state: Measuring } | undefined;
  panelOwnsEscape: boolean;
  loading: Loading | undefined;
};

export { SPINNER_FRAMES, SPINNER_MS };

export const STARTING_TEXT = 'starting the momonga daemon';
export const RECONNECTING_TEXT = 'reconnecting to the daemon';
export { DAEMON_STOPPING_TEXT } from '../../run/follow.ts';
export const MEASURING_TEXT = 'measuring this model (once per model and OS build)';

export const loadingText = (done: number, total: number): string => `loading the conversation ${done} of ${total} events`;

export const commandPhaseText = (label: string): string => `running ${label}`;

export const waitingOf = (facts: WaitingFacts): Waiting | undefined => {
  if (facts.startingSince !== undefined) return { phase: { text: STARTING_TEXT, startedAt: facts.startingSince }, cancelKey: 'prompt.interrupt' };
  if (facts.prompting) return undefined;
  const cancelKey: CancelKey = facts.panelOwnsEscape ? 'prompt.interrupt' : 'run.stop';
  if (facts.reconnectingSince !== undefined) return { phase: { text: RECONNECTING_TEXT, startedAt: facts.reconnectingSince }, cancelKey };
  if (facts.loading !== undefined) return { phase: { text: loadingText(facts.loading.done, facts.loading.total), startedAt: facts.loading.startedAt }, cancelKey: undefined };
  if (facts.run !== undefined) return { phase: facts.run, cancelKey };
  if (facts.command !== undefined) return { phase: facts.command, cancelKey };
  if (facts.measuring !== undefined) return { phase: { text: measuringStepOf(facts.measuring.state), startedAt: facts.measuring.since, detail: measuringSkipOf(facts.measuring.state) }, cancelKey: undefined };
  return undefined;
};

export const SECONDS_MS = 1000;

export type WaitingMark = { readonly kind: 'spinner'; readonly tick: number } | { readonly kind: 'static' };

export const waitingRowText = (waiting: Waiting, mark: WaitingMark, now: number, keys: KeyTable): string => {
  const seconds = Math.max(0, Math.floor((now - waiting.phase.startedAt) / 1000));
  const key = waiting.cancelKey === undefined ? '' : keys.keyHint(waiting.cancelKey);
  const cancel = key === '' ? '' : ` · ${key} to cancel`;
  const detail = waiting.phase.detail === undefined ? '' : ` · ${escapeTerminalLine(waiting.phase.detail)}`;
  return `${mark.kind === 'static' ? STATIC_MARK : SPINNER_FRAMES[mark.tick % SPINNER_FRAMES.length]} ${escapeTerminalLine(waiting.phase.text)} ${seconds}s${cancel}${detail}`;
};

export type WaitingRowProps = { waiting: Waiting; now(): number; timers: ScreenTimers; keys: KeyTable; reducedMotion: boolean; onTick?: () => void };

export function WaitingRow({ waiting, now, timers, keys, reducedMotion, onTick }: WaitingRowProps) {
  const [shown, setShown] = useState(() => ({ tick: 0, at: now() }));
  useEffect(
    () =>
      every(timers, reducedMotion ? SECONDS_MS : SPINNER_MS, () => {
        setShown((before) => ({ tick: before.tick + 1, at: now() }));
        onTick?.();
      }),
    [timers, now, reducedMotion, onTick],
  );
  return (
    <Text dimColor wrap="truncate">
      {waitingRowText(waiting, reducedMotion ? { kind: 'static' } : { kind: 'spinner', tick: shown.tick }, shown.at, keys)}
    </Text>
  );
}
