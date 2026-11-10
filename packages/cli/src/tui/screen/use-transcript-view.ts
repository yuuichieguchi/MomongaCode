import { useEffect, useEffectEvent, useMemo, useReducer, useState } from 'react';
import type { ActionId, KeyTable } from '../keys/table.ts';
import type { KeyEvent, MouseEvent, TerminalEvent } from '../terminal/events.ts';
import { copyMessage } from './clipboard.ts';
import type { CopyOutcome } from './clipboard.ts';
import { COPY_MAX_BYTES } from './constants.ts';
import type { ScreenTerminal } from './input.ts';
import { regionAt } from './layout.ts';
import type { RowAllocation } from './layout.ts';
import type { A11y } from './a11y.ts';
import { createRowCache, rowRenderersOf } from './row-cache.ts';
import { createClickCounter, extractSelection, indexRangeOf, lineSelection, samePoint, wordSelection } from './selection.ts';
import type { Point, Selection } from './selection.ts';
import { toggleThought } from '../transcript.ts';
import type { TranscriptStore } from './store.ts';
import { clamped, FOLLOWING, moved, sourceOf, VIEWPORT_CONTEXTS, viewportMoveOf, viewportMoveOfAction, windowOf } from './viewport.ts';
import type { Position, ViewportMove, ViewSource, ViewWindow } from './viewport.ts';

export type ViewportKeyFacts = { panelOpen: boolean; menuOpen: boolean; inputEmpty: boolean };

export type TranscriptViewHost = {
  store: TranscriptStore;
  terminal: ScreenTerminal;
  fullscreen: boolean;
  width: number;
  allocation: RowAllocation;
  copyOnSelect: boolean;
  now(): number;
  copy(text: string): Promise<CopyOutcome>;
  openLink(url: URL): void;
  reportError(error: unknown): void;
  keyFacts(): ViewportKeyFacts;
  keys: KeyTable;
  a11y: A11y;
};

export type TranscriptViewState = { source: ViewSource; window: ViewWindow; position: Position; selection: Selection | undefined; toast: string | undefined; showToast(text: string): void; act(action: ActionId): boolean; place(position: Position): void };

type Drag = { anchor: Point; selecting: boolean };

type Held = { position: Position; selection: Selection | undefined; toast: string | undefined; drag: Drag | undefined };

export const useTranscriptView = (host: TranscriptViewHost): TranscriptViewState => {
  const { store, terminal, width, allocation } = host;
  const height = allocation.viewport;
  const { keys } = host;
  const { screenReader, reducedMotion } = host.a11y;
  const cache = useMemo(() => createRowCache(rowRenderersOf({ keys, a11y: { screenReader, reducedMotion } })), [keys, screenReader, reducedMotion]);
  const [held] = useState<Held>(() => ({ position: FOLLOWING, selection: undefined, toast: undefined, drag: undefined }));
  const [clicks] = useState(() => createClickCounter(host.now));
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const source = sourceOf(store, cache, width);
  const position = clamped(source, held.position);
  const window = windowOf(source, position, height);

  useEffect(() => {
    const open = store.open();
    cache.retain(store, window.firstIndex, window.lastIndex, height, open === undefined ? undefined : store.byKey(open)?.id);
  });

  const change = (patch: Partial<Held>): void => {
    Object.assign(held, patch);
    redraw();
  };

  const windowNow = (): ViewWindow => windowOf(source, clamped(source, held.position), height);

  const move = (step: ViewportMove): void => change({ position: moved(source, clamped(source, held.position), height, step) });

  const say = (outcome: CopyOutcome): void => change({ toast: copyMessage(outcome) });

  const copySelection = (selection: Selection): void => {
    const extract = extractSelection(source, selection, COPY_MAX_BYTES);
    if (!extract.complete) {
      say({ kind: 'too-large', bytes: extract.bytes, through: 'any' });
      return;
    }
    if (extract.text === '') return;
    host.copy(extract.text).then(say, host.reportError);
  };

  const pointAt = (event: MouseEvent): Point | undefined => {
    const hit = regionAt(allocation, event.row);
    if (hit?.region !== 'viewport') return undefined;
    const visible = windowNow().rows[hit.row];
    return visible === undefined ? undefined : { entryId: visible.entryId, rowIndex: visible.rowIndex, col: event.col - 1 };
  };

  const linkAt = (point: Point): string | undefined => {
    const index = source.indexOfId(point.entryId);
    const row = index === undefined ? undefined : source.rowsOf(source.at(index))[point.rowIndex];
    const range = row === undefined ? undefined : indexRangeOf(row, point.col, point.col);
    if (row === undefined || range === undefined) return undefined;
    return row.links?.find(([start, end]) => start <= range[0] && range[0] < end)?.[2];
  };

  const press = (event: MouseEvent): void => {
    const hit = regionAt(allocation, event.row);
    if (hit?.region === 'viewport' && !clamped(source, held.position).following && hit.row === height - 1) {
      change({ position: moved(source, held.position, height, { kind: 'bottom' }), selection: undefined, toast: undefined, drag: undefined });
      return;
    }
    const point = pointAt(event);
    if (point === undefined) {
      change({ selection: undefined, toast: undefined, drag: undefined });
      return;
    }
    const count = clicks(point);
    const selection = count === 1 ? undefined : count === 2 ? wordSelection(source, point) : lineSelection(source, point);
    change({ selection, toast: undefined, drag: { anchor: selection?.anchor ?? point, selecting: selection !== undefined } });
  };

  const drag = (event: MouseEvent, dragging: Drag): void => {
    const hit = regionAt(allocation, event.row);
    if (hit?.region !== 'viewport') move({ kind: 'rows', rows: 1 });
    const visible = windowNow().rows;
    const last = visible.at(-1);
    const point = pointAt(event) ?? (last === undefined ? undefined : { entryId: last.entryId, rowIndex: last.rowIndex, col: Number.POSITIVE_INFINITY });
    if (point === undefined || (!dragging.selecting && samePoint(point, dragging.anchor))) return;
    change({ selection: { anchor: dragging.anchor, head: point }, drag: { anchor: dragging.anchor, selecting: true } });
  };

  const release = (event: MouseEvent, dragging: Drag): void => {
    const { selection } = held;
    change({ drag: undefined });
    if (dragging.selecting && selection !== undefined) {
      if (host.copyOnSelect) copySelection(selection);
      return;
    }
    const point = pointAt(event);
    if (point === undefined) return;
    const index = source.indexOfId(point.entryId);
    const clicked = index === undefined ? undefined : source.at(index).entry;
    if (clicked?.kind === 'thought' && clicked.endedAt !== undefined && point.rowIndex === 0) {
      toggleThought(store, clicked.itemId);
      return;
    }
    const url = linkAt(point);
    if (url !== undefined) host.openLink(new URL(url));
  };

  const onMouse = (event: MouseEvent): void => {
    const step = viewportMoveOf(event, height, keys);
    if (step !== undefined) move(step);
    else if (event.kind === 'press' && event.button === 'left') press(event);
    else if (event.kind === 'move' && held.drag !== undefined) drag(event, held.drag);
    else if (event.kind === 'release' && held.drag !== undefined) release(event, held.drag);
  };

  const actOnSelection = (action: ActionId | undefined): boolean => {
    if (held.selection === undefined) return false;
    if (action === 'selection.copy') {
      copySelection(held.selection);
      return true;
    }
    if (action === 'selection.clear') {
      change({ selection: undefined });
      return true;
    }
    return false;
  };

  const actOnViewport = (action: ActionId | undefined, modified: boolean): boolean => {
    const step = viewportMoveOfAction(action, height);
    if (step === undefined) return false;
    const facts = host.keyFacts();
    if (facts.panelOpen || facts.menuOpen || (!modified && !facts.inputEmpty)) return false;
    if (step.kind === 'bottom' && !modified && clamped(source, held.position).following) return false;
    move(step);
    return true;
  };

  const onKey = (event: KeyEvent): boolean => {
    const action = keys.actionOf(VIEWPORT_CONTEXTS, event);
    if (actOnSelection(action)) return true;
    if (held.selection !== undefined && keys.typedOf(event) !== undefined) change({ selection: undefined });
    return actOnViewport(action, event.ctrl);
  };

  const onEvent = useEffectEvent((event: TerminalEvent): boolean => {
    if (event.type === 'key' && held.toast !== undefined) change({ toast: undefined });
    if (!host.fullscreen) return false;
    if (event.type === 'mouse') {
      onMouse(event);
      return true;
    }
    return event.type === 'key' ? onKey(event) : false;
  });

  useEffect(() => terminal.input.claim((event) => onEvent(event)), [terminal]);

  return { source, window, position, selection: held.selection, toast: held.toast, showToast: (text) => change({ toast: text }), act: (action) => host.fullscreen && (actOnSelection(action) || actOnViewport(action, true)), place: (next) => change({ position: next }) };
};
