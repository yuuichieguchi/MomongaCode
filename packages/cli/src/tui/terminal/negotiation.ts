import type { TerminalEvent } from './events.ts';
import { DECRQM_ALT_SCREEN, DECRQM_SGR_MOUSE, DECRQM_SYNCHRONIZED_OUTPUT } from './modes.ts';

export const NEGOTIATION_STATES = ['unknown', 'plain', 'modify-other-keys', 'kitty', 'proven'] as const;

export type NegotiationState = (typeof NEGOTIATION_STATES)[number];

export type NewlineHint = 'shift+enter' | 'ctrl+j';

export const NEWLINE_HINT: Readonly<Record<NegotiationState, NewlineHint>> = {
  unknown: 'ctrl+j',
  plain: 'ctrl+j',
  'modify-other-keys': 'ctrl+j',
  kitty: 'shift+enter',
  proven: 'shift+enter',
};

export const isNegotiationState = (value: unknown): value is NegotiationState => NEGOTIATION_STATES.some((state) => state === value);

export type Negotiation = {
  state: NegotiationState;
  answersEnded: boolean;
  modes: ReadonlyMap<number, number>;
  backgroundColor: string | undefined;
};

export const negotiationFrom = (state: NegotiationState): Negotiation => ({ state, answersEnded: false, modes: new Map(), backgroundColor: undefined });

const forward = (current: NegotiationState, candidate: NegotiationState): NegotiationState => (NEGOTIATION_STATES.indexOf(candidate) > NEGOTIATION_STATES.indexOf(current) ? candidate : current);

const moved = (negotiation: Negotiation, candidate: NegotiationState): Negotiation => {
  const state = forward(negotiation.state, candidate);
  return state === negotiation.state ? negotiation : { ...negotiation, state };
};

export const advance = (negotiation: Negotiation, event: TerminalEvent): Negotiation => {
  if (event.type === 'key') return 'name' in event && event.name === 'enter' && event.shift ? moved(negotiation, 'proven') : negotiation;
  if (event.type !== 'report') return negotiation;
  if (event.kind === 'kitty-keys') return moved(negotiation, 'kitty');
  if (event.kind === 'device-attributes') return negotiation.answersEnded ? negotiation : { ...negotiation, answersEnded: true, state: forward(negotiation.state, 'plain') };
  if (event.kind === 'mode') return negotiation.modes.get(event.mode) === event.value ? negotiation : { ...negotiation, modes: new Map(negotiation.modes).set(event.mode, event.value) };
  if (event.kind === 'background-color') return negotiation.backgroundColor === event.color ? negotiation : { ...negotiation, backgroundColor: event.color };
  return negotiation;
};

export const modifyOtherKeysWanted = (before: Negotiation, after: Negotiation): boolean => before.state !== 'plain' && after.state === 'plain';

export const modifyOtherKeysSent = (negotiation: Negotiation): Negotiation => moved(negotiation, 'modify-other-keys');

const DECRPM_SET = 1;
const DECRPM_RESET = 2;
const DECRPM_NOT_RECOGNISED = 0;
const DECRPM_PERMANENTLY_RESET = 4;

const answeredSetOrReset = (negotiation: Negotiation, mode: number): boolean => {
  const value = negotiation.modes.get(mode);
  return value === DECRPM_SET || value === DECRPM_RESET;
};

export const mouseReported = (negotiation: Negotiation): boolean => answeredSetOrReset(negotiation, DECRQM_SGR_MOUSE);

export const synchronizedOutputReported = (negotiation: Negotiation): boolean => answeredSetOrReset(negotiation, DECRQM_SYNCHRONIZED_OUTPUT);

export const fullscreenRefused = (negotiation: Negotiation): boolean => {
  const value = negotiation.modes.get(DECRQM_ALT_SCREEN);
  return negotiation.answersEnded && (value === DECRPM_NOT_RECOGNISED || value === DECRPM_PERMANENTLY_RESET);
};
