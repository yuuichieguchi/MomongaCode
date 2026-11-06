export const MARKER_STATES = ['free', 'held', 'unknown'] as const;

export const MARKER_MODES = ['locked', 'listed'] as const;

export const MARKER_PHASES = ['idle', 'guarded', 'created', 'running', 'exited', 'ledgered', 'settled', 'refused', 'lost'] as const;

export type MarkerState = (typeof MARKER_STATES)[number];

export type MarkerMode = (typeof MARKER_MODES)[number];

export type MarkerPhase = (typeof MARKER_PHASES)[number];
