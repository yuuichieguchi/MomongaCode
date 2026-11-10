import type { KeyEvent } from '../terminal/events.ts';
import { isReserved, REASONS } from './bindings.ts';
import { pressedSpecOf, shownKey } from './table.ts';
import type { KeySpec } from './table.ts';

export const CAPTURE_CANCEL: KeySpec = 'escape';
export const CAPTURE_REMOVE: KeySpec = 'backspace';

export const captureTitle = (action: string): string => `Press the new key for ${action} (${shownKey(CAPTURE_CANCEL)} cancels, ${shownKey(CAPTURE_REMOVE)} removes the keys)`;

export type Captured = { readonly kind: 'cancel' } | { readonly kind: 'remove' } | { readonly kind: 'key'; readonly spec: KeySpec } | { readonly kind: 'refused'; readonly reason: string };

export const capturedOf = (event: KeyEvent): Captured => {
  const spec = pressedSpecOf(event);
  if (spec === CAPTURE_CANCEL) return { kind: 'cancel' };
  if (spec === CAPTURE_REMOVE) return { kind: 'remove' };
  return isReserved(spec) ? { kind: 'refused', reason: REASONS.reserved(shownKey(spec)) } : { kind: 'key', spec };
};
