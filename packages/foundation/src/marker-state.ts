export const MARKER_MODES = ['locked', 'listed'] as const;

export type MarkerState = 'free' | 'held' | 'unknown';

export type MarkerMode = (typeof MARKER_MODES)[number];
