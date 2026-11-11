export const MARKER_STATES = ['free', 'held', 'unknown'] as const;

export const MARKER_MODES = ['locked', 'listed'] as const;

export type MarkerState = (typeof MARKER_STATES)[number];

export type MarkerMode = (typeof MARKER_MODES)[number];
