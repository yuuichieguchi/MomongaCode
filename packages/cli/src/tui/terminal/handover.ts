import { HANDOVER_TERMINAL_ENV } from './constants.ts';
import type { HandoverTerminal, TerminalLayer } from './layer.ts';
import { isTerminalModeName, SCREEN_MODES } from './modes.ts';
import type { ScreenMode } from './modes.ts';
import type { NegotiationState } from './negotiation.ts';

const HANDOVER_TERMINAL_VERSION = 1;

export const handoverTerminalValue = (terminal: HandoverTerminal): string => JSON.stringify({ v: HANDOVER_TERMINAL_VERSION, screen: terminal.screen, modes: terminal.modes });

const isScreenMode = (value: unknown): value is ScreenMode => SCREEN_MODES.some((mode) => mode === value);

const jsonOf = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const parseHandoverTerminal = (value: string | undefined): HandoverTerminal | undefined => {
  if (value === undefined) return undefined;
  const parsed = jsonOf(value);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { v, screen, modes } = Object.fromEntries(Object.entries(parsed));
  if (v !== HANDOVER_TERMINAL_VERSION || !isScreenMode(screen) || !Array.isArray(modes)) return undefined;
  const names = modes.filter(isTerminalModeName);
  return names.length === modes.length ? { screen, modes: names } : undefined;
};

export const takeHandoverTerminal = (env: Record<string, string | undefined>): HandoverTerminal | undefined => {
  const value = env[HANDOVER_TERMINAL_ENV];
  delete env[HANDOVER_TERMINAL_ENV];
  return parseHandoverTerminal(value);
};

export const startFromHandover = (layer: Pick<TerminalLayer, 'adopt' | 'leaveEveryMode' | 'start'>, env: Record<string, string | undefined>, negotiation: NegotiationState): 'adopted' | 'lost' => {
  const terminal = takeHandoverTerminal(env);
  if (terminal === undefined) {
    layer.leaveEveryMode();
    layer.start();
    return 'lost';
  }
  layer.adopt(terminal, negotiation);
  return 'adopted';
};
