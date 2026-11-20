import { describe, expect, it } from 'vitest';
import { createClaimTable } from '../../src/tui/screen/input.ts';
import type { ClaimPriority } from '../../src/tui/screen/input.ts';
import { chordContextsOf, keyRouteOf } from '../../src/tui/screen/key-route.ts';
import type { KeyRouteFacts } from '../../src/tui/screen/key-route.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';

const plain = { ctrl: false, alt: false, shift: false };
const wheel: TerminalEvent = { type: 'mouse', kind: 'wheel', button: 'wheel-up', col: 1, row: 1, ...plain };

const idle: KeyRouteFacts = { trust: false, toolView: false, overlay: undefined, welcome: false, prompt: undefined, detail: false, shellDraft: false, menuOpen: false, agentsChosen: false, fullscreen: true };

describe('one claim table orders the claims by their priority, never by the order they were made in', () => {
  const offeredIn = (order: readonly ClaimPriority[]): string[] => {
    const table = createClaimTable();
    const seen: string[] = [];
    for (const priority of order) table.claim(priority, () => (seen.push(priority), priority === 'transcript'));
    expect(table.offer(wheel)).toBe(true);
    return seen;
  };

  it('offers the wheel to the prompt pointer first and to the transcript when the pointer declines, whichever claimed first', () => {
    expect(offeredIn(['transcript', 'prompt-pointer', 'typing'])).toEqual(['prompt-pointer', 'transcript']);
    expect(offeredIn(['typing', 'prompt-pointer', 'transcript'])).toEqual(['prompt-pointer', 'transcript']);
  });

  it('stops offering to a claim that was given back', () => {
    const table = createClaimTable();
    const stop = table.claim('typing', () => true);
    stop();
    expect(table.offer(wheel)).toBe(false);
  });
});

describe('the keyboard is routed by one value', () => {
  it('gives the key to the highest state: trust, the tool output view, an overlay (also the screen kept until the next screen of a flow replaces it), the welcome, a run prompt, the list of views, the shell draft, the menu, the editor', () => {
    expect(keyRouteOf({ ...idle, trust: true, overlay: 'pick', prompt: 'decision', menuOpen: true })).toBe('trust');
    expect(keyRouteOf({ ...idle, toolView: true, overlay: 'pick' })).toBe('tool-view');
    expect(keyRouteOf({ ...idle, overlay: 'loading', prompt: 'decision' })).toBe('overlay');
    expect(keyRouteOf({ ...idle, overlay: 'kept', prompt: 'decision', menuOpen: true })).toBe('overlay');
    expect(keyRouteOf({ ...idle, welcome: true, menuOpen: true })).toBe('welcome');
    expect(keyRouteOf({ ...idle, prompt: 'decision', shellDraft: true, menuOpen: true })).toBe('prompt');
    expect(keyRouteOf({ ...idle, prompt: 'decision', agentsChosen: true })).toBe('prompt');
    expect(keyRouteOf({ ...idle, agentsChosen: true, shellDraft: true, menuOpen: true })).toBe('agents');
    expect(keyRouteOf({ ...idle, shellDraft: true, menuOpen: true })).toBe('shell');
    expect(keyRouteOf({ ...idle, menuOpen: true })).toBe('menu');
    expect(keyRouteOf(idle)).toBe('editor');
  });

  it('checks the first key of a chord only against the contexts of the state that has the keys', () => {
    expect(chordContextsOf({ ...idle, prompt: 'decision' })).toEqual(['select']);
    expect(chordContextsOf({ ...idle, prompt: 'decision', detail: true })).toEqual(['viewer']);
    expect(chordContextsOf({ ...idle, prompt: 'fields' })).toEqual(['select', 'chat']);
    expect(chordContextsOf({ ...idle, trust: true })).toEqual(['select']);
    expect(chordContextsOf({ ...idle, toolView: true })).toEqual(['viewer']);
    expect(chordContextsOf({ ...idle, overlay: 'pick' })).toEqual(['select']);
    expect(chordContextsOf({ ...idle, overlay: 'pick', detail: true })).toEqual(['viewer']);
    expect(chordContextsOf({ ...idle, overlay: 'text' })).toEqual(['select', 'chat']);
    expect(chordContextsOf({ ...idle, overlay: 'capture' })).toEqual([]);
    expect(chordContextsOf({ ...idle, overlay: 'kept' })).toEqual(['select']);
    expect(chordContextsOf({ ...idle, welcome: true })).toEqual([]);
    expect(chordContextsOf({ ...idle, shellDraft: true })).toEqual(['shell', 'viewport', 'chat', 'global']);
    expect(chordContextsOf({ ...idle, agentsChosen: true })).toEqual(['agents', 'viewport', 'chat', 'global']);
    expect(chordContextsOf({ ...idle, menuOpen: true })).toEqual(['menu', 'viewport', 'chat', 'global']);
    expect(chordContextsOf({ ...idle, fullscreen: false })).toEqual(['chat', 'global']);
  });
});
