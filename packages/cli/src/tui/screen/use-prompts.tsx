import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { escapeTerminalLine } from '@momonga/protocol';
import { cleanFailureMessage } from '@momonga/foundation';
import { couldNotOpenBrowser } from '../../browser-text.ts';
import { currentRequest, decide, enterValue, leaveFields, withError } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import { PASTED_CALLBACK_MAX_BYTES, pastedCallbackProblem } from '../../plan/sign-in.ts';
import type { TuiBackend } from '../backend.ts';
import { applyAction, applyKeyEvent, emptyEditor, insertText, placeText } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { editorUnsetHint } from '../external-editor.ts';
import type { ExternalEditorPort } from '../external-editor.ts';
import { capturedOf } from '../keys/capture.ts';
import type { ActionId, KeyContext, KeyTable } from '../keys/table.ts';
import { LOADING_HINTS, OverlayView, pickerSpec } from '../picker.tsx';
import type { KeptScreen, Loaded, LoadingHint, Overlay, OverlayPorts, PickChoice, PickRequest, PickUpdate, WaitingOverlay } from '../picker.tsx';
import { detailCapacity, detailTop, DetailView, SELECT_CONTEXTS, selectClick, selectHover, selectKey, selectLayout, selectRowAt, selectStart, selectText, SelectView, selectWheel, selectWithFilter } from '../select.tsx';
import type { SelectFrame, SelectLayout, SelectLine, SelectOutcome, SelectSpec, SelectState, SelectStep, TextRow } from '../select.tsx';
import type { KeyEvent, TerminalEvent } from '../terminal/events.ts';
import { promptTakesFocus, toolOf, withElicitationFlow } from '../transcript.ts';
import type { Entry, PendingApproval, PendingElicitation } from '../transcript.ts';
import { WHEEL_ROWS } from './constants.ts';
import { untilNextKey } from './input.ts';
import type { ScreenTerminal } from './input.ts';
import { regionAt } from './layout.ts';
import type { RowAllocation } from './layout.ts';
import type { Invitation } from './menu.tsx';
import { approvalSpec, approvalWording, decisionChoices, ElicitationFields, elicitationSpec, TRUST_CHOICES, trustSpec } from './prompt-panel.tsx';
import type { TrustDecision } from './prompt-panel.tsx';
import type { TranscriptState, TranscriptStore } from './store.ts';
import { Abandoned, currentScope, currentStep, inScope, untilAbandoned } from '../flow-step.ts';
import type { FlowScope, FlowStep } from '../flow-step.ts';

const WAITING_INPUT_BYTES = PASTED_CALLBACK_MAX_BYTES + 1;

const CLIPBOARD_ASKED = 'Asked the terminal to copy the sign-in URL.';

const prefixWithin = (text: string, bytes: number): string => {
  let kept = '';
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > bytes) break;
    kept += character;
    used += size;
  }
  return kept;
};

const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const VIEWER_CONTEXTS: readonly KeyContext[] = ['viewer'];

const selectActionOf = (event: KeyEvent, keys: KeyTable): ActionId | undefined => keys.actionOf(SELECT_CONTEXTS, event);

const TEXT_CONTEXTS: readonly KeyContext[] = [...SELECT_CONTEXTS, 'chat'];

const titleOf = (screen: KeptScreen): string => {
  switch (screen.kind) {
    case 'pick':
      return screen.request.title ?? '';
    case 'text':
    case 'capture':
      return screen.request.title;
    case 'waiting':
      return screen.view.title;
    case 'loading':
      return screen.title;
  }
};

type TextOverlay = Extract<Overlay, { kind: 'text' }>;

export type PromptsHost = {
  backend: TuiBackend;
  store: TranscriptStore;
  terminal: ScreenTerminal;
  keepTyped(text: string): void;
  columns: number;
  panelRows: number;
  keys: KeyTable;
  screenReader: boolean;
  interruptRun(): void;
  stopActive(): void;
  reportError(error: unknown): void;
  fail(error: unknown): void;
  exit(): void;
  append(entry: Entry): void;
  decideTrust(decision: TrustDecision): void;
  externalEditor: ExternalEditorPort;
};

export type PanelFacts = { trustPath: string | undefined; ready: boolean };

export type Prompts = {
  overlayPorts: OverlayPorts;
  overlay: Overlay | undefined;
  invitation: Invitation | undefined;
  invite(invitation: Invitation): void;
  dismissInvitation(): void;
  flow<T>(work: () => Promise<T>): Promise<T>;
  raise(kind: string, work: () => Promise<void>): Promise<void>;
  waitWords(phase: string): (() => void) | undefined;
  screenId(trust: boolean): string;
  isProductPanel(trust: boolean): boolean;
  undrawnKey(event: KeyEvent, keys: KeyTable): void;
  undrawnPaste(text: string): void;
  overlayKind(): Overlay['kind'] | undefined;
  promptStage(): 'decision' | 'fields' | undefined;
  detailShown(facts: PanelFacts): boolean;
  trustKey(path: string, event: KeyEvent, keys: KeyTable): void;
  overlayKey(event: KeyEvent, keys: KeyTable): boolean;
  runPromptKey(event: KeyEvent, keys: KeyTable): boolean;
  paste(text: string): boolean;
  panel(facts: PanelFacts): ReactNode | undefined;
  press(facts: PanelFacts, row: number): void;
  hover(facts: PanelFacts, row: number): boolean;
  wheel(facts: PanelFacts, rows: number): void;
};

type Active = { owner: string; spec: SelectSpec; border: boolean; sending: boolean; on(outcome: SelectOutcome): void; highlighted?: (index: number) => void };

const TRUST_OWNER = 'trust';

const DIGIT = /^[1-9]$/;

const approvalOwner = (approval: PendingApproval): string => `approval:${approval.approvalId}`;

const waitingCount = (state: TranscriptState): number =>
  (state.approval === undefined ? 0 : 1) + state.queuedApprovals.length + (state.elicitation === undefined ? 0 : 1) + state.queuedElicitations.length;

export type PromptPointerHost = {
  terminal: ScreenTerminal;
  active: boolean;
  allocation: RowAllocation;
  panelOpen: boolean;
  menuOpen: boolean;
  panelPress(row: number): void;
  panelWheel(rows: number): void;
  menuPress(row: number): void;
  menuWheel(rows: number): void;
};

export const usePromptPointer = (host: PromptPointerHost): void => {
  const onEvent = useEffectEvent((event: TerminalEvent): boolean => {
    if (!host.active || event.type !== 'mouse') return false;
    const hit = regionAt(host.allocation, event.row);
    if (hit === undefined) return false;
    const panel = hit.region === 'input' && host.panelOpen;
    if (!panel && !(hit.region === 'menu' && host.menuOpen)) return false;
    if (event.kind === 'press' && event.button === 'left') (panel ? host.panelPress : host.menuPress)(hit.row);
    else if (event.button === 'wheel-up') (panel ? host.panelWheel : host.menuWheel)(-WHEEL_ROWS);
    else if (event.button === 'wheel-down') (panel ? host.panelWheel : host.menuWheel)(WHEEL_ROWS);
    return true;
  });
  const { terminal } = host;
  useEffect(() => terminal.input.claim('prompt-pointer', (event) => onEvent(event)), [terminal]);
};

type Layer = { readonly scope: FlowScope; readonly screen: number; readonly overlay: Overlay; readonly openedIn: FlowStep | undefined; readonly leave: (() => void) | undefined };

type PickOverlay = Extract<Overlay, { kind: 'pick' }>;

const keptOf = (overlay: Overlay): Extract<Overlay, { kind: 'kept' }> => (overlay.kind === 'kept' ? overlay : { kind: 'kept', shown: overlay });

const lateStep = (): FlowStep | undefined => {
  const step = currentStep();
  return step?.signal.aborted === true ? step : undefined;
};

export const usePrompts = (host: PromptsHost): Prompts => {
  const { backend, store, terminal } = host;
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const selections = useRef(new Map<string, SelectState>());
  const panelSelection = useRef<{ owner: string; state: SelectState } | undefined>(undefined);
  const sent = useRef<string | undefined>(undefined);
  const failed = useRef<{ owner: string; text: string } | undefined>(undefined);
  const detail = useRef<{ owner: string; top: number } | undefined>(undefined);
  const texts = useRef<{ owner: string; width: number; title: string | undefined; lines: number; rows: TextRow[] } | undefined>(undefined);
  const approvalText = useRef<{ approvalId: string; title: string; lines: SelectLine[] } | undefined>(undefined);
  const flowGeneration = useRef(0);
  const elicitEditorRef = useRef<EditorState>(emptyEditor());
  const flowRef = useRef<{ inputId: string; flow: ElicitationFlow } | undefined>(undefined);
  const layers = useRef<Layer[]>([]);
  const editors = useRef(new Map<number, EditorState>());
  const watching = useRef(new Map<number, () => void>());
  const screens = useRef(0);
  const scopeCount = useRef(0);
  const loose = useRef<FlowScope>({ id: 0, raised: undefined, steps: [] });
  const liveScopes = useRef(new Set<FlowScope>());
  const raising = useRef(new Set<string>());
  const [invitation, setInvitation] = useState<Invitation | undefined>(undefined);

  const topLayer = (): Layer | undefined => layers.current.at(-1);

  const scopeNow = (): FlowScope => currentScope() ?? loose.current;

  const layerOf = (scope: FlowScope): Layer | undefined => layers.current.find((layer) => layer.scope === scope);

  const stopWatching = (screen: number): void => {
    watching.current.get(screen)?.();
    watching.current.delete(screen);
  };

  const forget = (layer: Layer): void => {
    selections.current.delete(`pick:${layer.screen}`);
    editors.current.delete(layer.screen);
    stopWatching(layer.screen);
  };

  const place = (scope: FlowScope, next: Layer | undefined): void => {
    const list = layers.current;
    const at = list.findIndex((layer) => layer.scope === scope);
    const before = list[at];
    if (before !== undefined && before.screen !== next?.screen) forget(before);
    if (next === undefined) {
      if (at !== -1) list.splice(at, 1);
    } else if (at !== -1) list[at] = next;
    else if (scope.raised !== undefined) list.push(next);
    else {
      const raised = list.findIndex((layer) => layer.scope.raised !== undefined);
      list.splice(raised === -1 ? list.length : raised, 0, next);
    }
    redraw();
  };

  const isShown = (layer: Layer): Layer | undefined => {
    const current = layerOf(layer.scope);
    return current?.screen === layer.screen ? current : undefined;
  };

  const open = (overlay: Overlay, leave?: () => void): Layer => {
    const scope = scopeNow();
    screens.current += 1;
    const layer: Layer = { scope, screen: screens.current, overlay, openedIn: currentStep(), leave };
    place(scope, layer);
    return layer;
  };

  const change = (layer: Layer, overlay: Overlay): void => {
    const current = isShown(layer);
    if (current !== undefined) place(current.scope, { ...current, overlay });
  };

  const close = (layer: Layer): void => {
    if (isShown(layer) !== undefined) place(layer.scope, undefined);
  };

  const answered = (layer: Layer): void => {
    stopWatching(layer.screen);
    const current = isShown(layer);
    if (current === undefined) return;
    if (!liveScopes.current.has(current.scope)) {
      place(current.scope, undefined);
      return;
    }
    place(current.scope, { ...current, overlay: keptOf(current.overlay) });
  };

  const left = (layer: Layer, outside: () => void): void => {
    const step = layer.openedIn;
    if (step === undefined || layer.leave === undefined) {
      close(layer);
      outside();
      return;
    }
    answered(layer);
    step.abandon();
    layer.leave();
  };

  const editorOf = (layer: Layer): EditorState => editors.current.get(layer.screen) ?? emptyEditor();

  const replaceEditor = (layer: Layer, next: EditorState): void => {
    editors.current.set(layer.screen, next);
    redraw();
  };

  const replaceElicitEditor = (next: EditorState): void => {
    elicitEditorRef.current = next;
    redraw();
  };

  const updatePick = (layer: Layer, update: PickUpdate): void => {
    const current = isShown(layer);
    if (current?.overlay.kind !== 'pick') return;
    const { alt: _previousAlt, ...base } = current.overlay.request;
    const alt = 'alt' in update ? update.alt : current.overlay.request.alt;
    const request: PickRequest = { ...base, rows: update.rows, ...(update.lines === undefined ? {} : { lines: update.lines }), ...(alt === undefined ? {} : { alt }) };
    const filter = selections.current.get(`pick:${current.screen}`)?.filter ?? '';
    selections.current.set(`pick:${current.screen}`, selectWithFilter({ ...pickerSpec(request), initial: update.highlight }, filter));
    change(current, { ...current.overlay, request });
  };

  const openPick = (request: PickRequest, resolve: (choice: PickChoice | undefined) => void, reject: (error: unknown) => void): void => {
    const late = lateStep();
    if (late !== undefined) {
      reject(late.signal.reason);
      return;
    }
    request.onHighlight?.(pickerSpec(request).initial);
    const layer = open({ kind: 'pick', request, resolve }, () => reject(new Abandoned()));
    if (request.watch !== undefined) watching.current.set(layer.screen, request.watch((update) => updatePick(layer, update)));
  };

  const overlayPorts: OverlayPorts = {
    pick: (request) =>
      new Promise((resolve, reject) => {
        openPick(request, (choice) => resolve(choice?.index), reject);
      }),
    choose: (request) =>
      new Promise((resolve, reject) => {
        openPick(request, resolve, reject);
      }),
    captureKey: (request) =>
      new Promise((resolve, reject) => {
        const late = lateStep();
        if (late !== undefined) {
          reject(late.signal.reason);
          return;
        }
        open({ kind: 'capture', request, resolve }, () => reject(new Abandoned()));
      }),
    promptText: (request) =>
      new Promise((resolve, reject) => {
        const late = lateStep();
        if (late !== undefined) {
          reject(late.signal.reason);
          return;
        }
        const initial = request.initial ?? '';
        const layer = open({ kind: 'text', request, resolve }, () => reject(new Abandoned()));
        editors.current.set(layer.screen, { ...emptyEditor(), text: initial, cursor: initial.length });
      }),
    waiting: (view, handlers) => {
      if (lateStep() !== undefined) {
        handlers.cancel();
        return;
      }
      const current = layerOf(scopeNow());
      if (current?.overlay.kind === 'waiting') {
        change(current, { ...current.overlay, view, handlers });
        return;
      }
      open({ kind: 'waiting', view, handlers, delivered: false });
    },
    delivered: () => {
      const current = layerOf(scopeNow());
      if (current?.overlay.kind !== 'waiting' || current.overlay.delivered) return;
      editors.current.delete(current.screen);
      const { problem: _problem, status: _status, ...rest } = current.overlay;
      change(current, { ...rest, delivered: true });
    },
    closeWaiting: () => {
      const current = layerOf(scopeNow());
      if (current?.overlay.kind !== 'waiting') return;
      if (current.overlay.delivered) answered(current);
      else close(current);
    },
    loading: <T,>(title: string, read: () => Promise<T>, hint: LoadingHint) =>
      new Promise<Loaded<T>>((resolve, reject) => {
        const late = lateStep();
        if (late !== undefined) {
          reject(late.signal.reason);
          return;
        }
        let reading = true;
        const layer: Layer = open(
          {
            kind: 'loading',
            title,
            hint,
            cancel: () => {
              if (!reading) return;
              reading = false;
              left(layer, () => resolve({ kind: 'cancelled' }));
            },
          },
          () => reject(new Abandoned()),
        );
        const answeredRead = async (): Promise<T> => read();
        answeredRead().then(
          (value) => {
            if (!reading) return;
            reading = false;
            answered(layer);
            resolve({ kind: 'read', value });
          },
          (error: unknown) => {
            if (!reading) return;
            reading = false;
            answered(layer);
            reject(errorOf(error));
          },
        );
      }),
    read: async <T,>(read: () => Promise<T>): Promise<Loaded<T>> => {
      const late = lateStep();
      if (late !== undefined) throw late.signal.reason;
      const answeredRead = async (): Promise<T> => read();
      return { kind: 'read', value: await untilAbandoned(currentStep(), answeredRead()) };
    },
    closeScreen: () => {
      if (lateStep() !== undefined) return;
      const current = layerOf(scopeNow());
      if (current?.overlay.kind === 'kept') close(current);
    },
  };

  const waitWords = (phase: string): (() => void) | undefined => {
    const scope = currentScope();
    const current = scope === undefined ? undefined : layerOf(scope);
    if (current?.overlay.kind !== 'kept' || lateStep() !== undefined) return undefined;
    change(current, { ...current.overlay, phase });
    return () => {
      const now = isShown(current);
      if (now?.overlay.kind === 'kept') change(now, { kind: 'kept', shown: now.overlay.shown });
    };
  };

  const ownSelection = (owner: string): boolean => owner.startsWith('pick:');

  const stateOf = (active: Active): SelectState => {
    if (ownSelection(active.owner)) return selections.current.get(active.owner) ?? selectStart(active.spec);
    return panelSelection.current?.owner === active.owner ? panelSelection.current.state : selectStart(active.spec);
  };

  const frameOf = (active: Active): SelectFrame => ({ width: host.columns, rows: host.panelRows, border: active.border && !host.screenReader });

  const textOf = (active: Active): readonly TextRow[] => {
    const frame = frameOf(active);
    const kept = texts.current;
    if (kept !== undefined && kept.owner === active.owner && kept.width === frame.width && kept.title === active.spec.title && kept.lines === (active.spec.lines?.length ?? 0)) return kept.rows;
    const rows = selectText(active.spec, frame);
    texts.current = { owner: active.owner, width: frame.width, title: active.spec.title, lines: active.spec.lines?.length ?? 0, rows };
    return rows;
  };

  const errorFor = (active: Active): string | undefined => (failed.current?.owner === active.owner ? failed.current.text : undefined);

  const layoutOf = (active: Active): SelectLayout => selectLayout(active.spec, stateOf(active), textOf(active), frameOf(active), (errorFor(active) === undefined ? 0 : 1) + (host.screenReader ? 1 : 0), host.screenReader);

  const detailOf = (active: Active): { owner: string; top: number } | undefined => (detail.current?.owner === active.owner ? detail.current : undefined);

  const apply = (active: Active, step: SelectStep): void => {
    const before = stateOf(active).index;
    if (ownSelection(active.owner)) selections.current.set(active.owner, step.state);
    else panelSelection.current = { owner: active.owner, state: step.state };
    redraw();
    if (step.state.index !== before) active.highlighted?.(step.state.index);
    if (step.outcome !== undefined) active.on(step.outcome);
  };

  const scrollDetail = (active: Active, top: number): void => {
    detail.current = { owner: active.owner, top: detailTop(textOf(active), frameOf(active), top) };
    redraw();
  };

  const detailKey = (active: Active, shown: { top: number }, event: KeyEvent, keys: KeyTable): void => {
    const page = detailCapacity(frameOf(active));
    const action = keys.actionOf(VIEWER_CONTEXTS, event, 'plain');
    if (action === 'viewer.close') {
      detail.current = undefined;
      redraw();
    } else if (action === 'viewer.up') scrollDetail(active, shown.top - 1);
    else if (action === 'viewer.down') scrollDetail(active, shown.top + 1);
    else if (action === 'viewer.pageUp') scrollDetail(active, shown.top - page);
    else if (action === 'viewer.pageDown') scrollDetail(active, shown.top + page);
  };

  const typedAside = (active: Active, event: KeyEvent, keys: KeyTable): string | undefined => {
    const typed = keys.typedOf(event);
    if (typed === undefined || active.spec.filter || DIGIT.test(typed)) return undefined;
    return keys.actionOf(SELECT_CONTEXTS, event, 'plain') === undefined ? typed : undefined;
  };

  const selectInput = (active: Active, event: KeyEvent, keys: KeyTable): void => {
    const action = active.spec.filter && keys.typedOf(event) !== undefined ? undefined : keys.actionOf(SELECT_CONTEXTS, event, 'plain');
    if (action === 'select.interrupt') {
      active.on({ kind: 'interrupt', action: active.spec.interrupt });
      return;
    }
    if (active.sending) return;
    const aside = typedAside(active, event, keys);
    if (aside !== undefined) {
      host.keepTyped(aside);
      return;
    }
    const shown = detailOf(active);
    if (shown !== undefined) {
      detailKey(active, shown, event, keys);
      return;
    }
    const layout = layoutOf(active);
    if (action === 'select.detail') {
      if (layout.more > 0) scrollDetail(active, 0);
      return;
    }
    apply(active, selectKey(active.spec, stateOf(active), event, keys, layout.capacity));
  };

  const selectPress = (active: Active, row: number): void => {
    if (active.sending || detailOf(active) !== undefined) return;
    const index = selectRowAt(layoutOf(active), row);
    if (index !== undefined) apply(active, selectClick(active.spec, stateOf(active), index));
  };

  const selectHoverAt = (active: Active, row: number): boolean => {
    if (active.sending || detailOf(active) !== undefined) return false;
    const index = selectRowAt(layoutOf(active), row);
    if (index === undefined) return false;
    const state = stateOf(active);
    const next = selectHover(active.spec, state, index);
    if (next === state) return false;
    if (next.index !== state.index) apply(active, { state: next });
    return true;
  };

  const selectScroll = (active: Active, rows: number): void => {
    const shown = detailOf(active);
    if (shown !== undefined) {
      scrollDetail(active, shown.top + rows);
      return;
    }
    apply(active, { state: selectWheel(active.spec, stateOf(active), rows, layoutOf(active).capacity) });
  };

  const selectView = (active: Active): ReactNode => {
    const shown = detailOf(active);
    if (shown !== undefined) return <DetailView text={textOf(active)} frame={frameOf(active)} top={shown.top} keys={host.keys} />;
    const error = errorFor(active);
    return <SelectView spec={active.spec} state={stateOf(active)} layout={layoutOf(active)} border={frameOf(active).border} sending={active.sending} keys={host.keys} {...(error === undefined ? {} : { error })} />;
  };

  const markSent = (owner: string): void => {
    sent.current = owner;
    failed.current = undefined;
    redraw();
  };

  const approvalTextOf = (approval: PendingApproval): { title: string; lines: SelectLine[] } => {
    const kept = approvalText.current;
    if (kept !== undefined && kept.approvalId === approval.approvalId) return kept;
    const next = { approvalId: approval.approvalId, ...approvalWording(approval, (callId) => toolOf(store, callId)) };
    approvalText.current = next;
    return next;
  };

  const approvalActive = (approval: PendingApproval): Active => {
    const owner = approvalOwner(approval);
    const { title, lines } = approvalTextOf(approval);
    return {
      owner,
      spec: approvalSpec(approval, title, lines, waitingCount(store.state())),
      border: true,
      sending: sent.current === owner,
      on: (outcome) => {
        if (outcome.kind === 'interrupt') {
          host.interruptRun();
          return;
        }
        const option = outcome.kind === 'decide' ? approval.options[outcome.index] : undefined;
        if (option === undefined) return;
        markSent(owner);
        backend.resolveApproval(approval.approvalId, option.optionId).catch((error: unknown) => {
          if (store.state().approval?.approvalId !== approval.approvalId) {
            host.reportError(error);
            return;
          }
          sent.current = undefined;
          failed.current = { owner, text: errorOf(error).message };
          redraw();
        });
      },
    };
  };

  const flowOf = (pending: PendingElicitation): ElicitationFlow => (flowRef.current?.inputId === pending.inputId ? flowRef.current.flow : pending.flow);

  const applyFlow = (pending: PendingElicitation, flow: ElicitationFlow, submitted = false): void => {
    flowRef.current = { inputId: pending.inputId, flow };
    flowGeneration.current += 1;
    withElicitationFlow(store, flow, submitted);
  };

  const proceedFlow = (pending: PendingElicitation, flow: ElicitationFlow): void => {
    if (!flow.complete) {
      applyFlow(pending, flow);
      return;
    }
    applyFlow(pending, flow, true);
    for (const notice of flow.notices) host.append({ kind: 'notice', level: 'warning', text: escapeTerminalLine(`MCP server ${cleanFailureMessage(pending.server)}: ${notice}`) });
    backend.resolveElicitation(pending.inputId, flow.answers).catch((error: unknown) => {
      applyFlow(pending, withError({ ...flow, complete: false, stage: 'decision' }, errorOf(error).message));
    });
  };

  const decideFlow = (pending: PendingElicitation, decision: ElicitationDecision | undefined): void => {
    if (decision === undefined) return;
    const flow = flowOf(pending);
    const request = currentRequest(flow);
    if (decision === 'accept' && request.mode === 'url') {
      decide(flow, decision).then((next) => {
        backend.openUrl(new URL(request.url), untilNextKey(terminal.input), (message) => {
          host.append({ kind: 'notice', level: 'warning', text: escapeTerminalLine(`MCP server ${cleanFailureMessage(pending.server)}: ${couldNotOpenBrowser(message)} Open this URL to continue: ${request.url}`) });
        });
        proceedFlow(pending, next);
      }, host.fail);
      return;
    }
    decide(flow, decision).then((next) => proceedFlow(pending, next), host.fail);
  };

  const elicitationActive = (pending: PendingElicitation): Active => {
    const flow = flowOf(pending);
    return {
      owner: `input:${pending.inputId}:${flowGeneration.current}`,
      spec: elicitationSpec({ ...pending, flow }, toolOf(store, pending.callId)?.title ?? pending.callId, waitingCount(store.state())),
      border: true,
      sending: pending.submitted,
      on: (outcome) => {
        if (outcome.kind === 'interrupt') host.interruptRun();
        else if (outcome.kind === 'decide') decideFlow(pending, decisionChoices(flow)[outcome.index]?.decision);
      },
    };
  };

  const elicitationKey = (pending: PendingElicitation, event: KeyEvent, keys: KeyTable): void => {
    const flow = flowOf(pending);
    if (flow.stage === 'decision') {
      selectInput(elicitationActive(pending), event, keys);
      return;
    }
    const action = selectActionOf(event, keys);
    if (action === 'select.interrupt') {
      host.interruptRun();
      return;
    }
    if (pending.submitted) return;
    if (action === 'select.escape') {
      applyFlow(pending, leaveFields(flow));
      return;
    }
    if (action === 'select.decide' && elicitEditorRef.current.text === '') {
      enterValue(flow, '').then((next) => proceedFlow(pending, next), host.fail);
      return;
    }
    const outcome = applyKeyEvent(elicitEditorRef.current, event, keys);
    replaceElicitEditor(outcome.state);
    if (outcome.submit !== undefined) enterValue(flow, outcome.submit).then((next) => proceedFlow(pending, next), host.fail);
  };

  const trustActive = (path: string): Active => ({
    owner: TRUST_OWNER,
    spec: trustSpec(path),
    border: true,
    sending: sent.current === TRUST_OWNER,
    on: (outcome) => {
      if (outcome.kind === 'interrupt') {
        host.exit();
        return;
      }
      const choice = outcome.kind === 'decide' ? TRUST_CHOICES[outcome.index] : undefined;
      if (choice === undefined) return;
      markSent(TRUST_OWNER);
      host.decideTrust(choice.decision);
    },
  });

  const pickActive = (layer: Layer, current: PickOverlay): Active => ({
    owner: `pick:${layer.screen}`,
    spec: pickerSpec(current.request),
    border: true,
    sending: false,
    ...(current.request.onHighlight === undefined ? {} : { highlighted: current.request.onHighlight }),
    on: (outcome) => {
      if (outcome.kind === 'alt' && current.request.alt === undefined) return;
      if (outcome.kind === 'decide' || outcome.kind === 'alt') {
        answered(layer);
        current.resolve({ index: outcome.index, alt: outcome.kind === 'alt' });
        return;
      }
      answered(layer);
      current.resolve(undefined);
    },
  });

  const panelActive = ({ trustPath, ready }: PanelFacts): Active | undefined => {
    if (trustPath !== undefined) return trustActive(trustPath);
    const top = topLayer();
    if (top !== undefined) return top.overlay.kind === 'pick' ? pickActive(top, top.overlay) : undefined;
    if (!ready) return undefined;
    const state = store.state();
    if (state.elicitation !== undefined) return flowOf(state.elicitation).stage === 'decision' ? elicitationActive(state.elicitation) : undefined;
    return state.approval === undefined || !promptTakesFocus(state) ? undefined : approvalActive(state.approval);
  };

  const fieldsShown = (facts: PanelFacts): PendingElicitation | undefined => (facts.ready && facts.trustPath === undefined && topLayer() === undefined ? store.state().elicitation : undefined);

  const typeIntoWaiting = (layer: Layer, current: WaitingOverlay, after: EditorState): void => {
    const before = editorOf(layer);
    replaceEditor(layer, after);
    if (after.text === before.text) return;
    if (current.problem !== undefined) {
      const { problem: _problem, ...rest } = current;
      change(layer, rest);
    }
  };

  const roomOf = (editor: EditorState): number => WAITING_INPUT_BYTES - Buffer.byteLength(editor.text, 'utf8');

  const pasteIntoWaiting = (layer: Layer, current: WaitingOverlay, text: string): void => {
    const before = editorOf(layer);
    typeIntoWaiting(layer, current, insertText(before, prefixWithin(text, roomOf(before))));
  };

  const editWaiting = (layer: Layer, current: WaitingOverlay, event: KeyEvent, keys: KeyTable): void => {
    const typed = keys.typedOf(event);
    if (typed !== undefined) pasteIntoWaiting(layer, current, typed);
    else typeIntoWaiting(layer, current, applyKeyEvent(editorOf(layer), event, keys).state);
  };

  const submitWaiting = (layer: Layer, current: WaitingOverlay): void => {
    const text = editorOf(layer).text;
    if (text.trim() === '') return;
    const problem = pastedCallbackProblem(text, current.view.state);
    replaceEditor(layer, emptyEditor());
    if (problem !== undefined) {
      change(layer, { ...current, problem });
      return;
    }
    current.handlers.deliver(text);
  };

  const waitingKey = (layer: Layer, current: WaitingOverlay, event: KeyEvent, keys: KeyTable): void => {
    const action = selectActionOf(event, keys);
    if (action === 'select.escape' || action === 'select.interrupt') {
      current.handlers.cancel();
      if (layer.openedIn === undefined) {
        if (current.delivered) close(layer);
        return;
      }
      answered(layer);
      layer.openedIn.abandon();
    } else if (current.delivered) return;
    else if (action === 'select.copy') {
      backend.copyToClipboard(current.view.url.href).catch(host.reportError);
      change(layer, { ...current, status: CLIPBOARD_ASKED });
    } else if (action === 'select.decide') submitWaiting(layer, current);
    else editWaiting(layer, current, event, keys);
  };

  const captureKey = (layer: Layer, current: Extract<Overlay, { kind: 'capture' }>, event: KeyEvent): void => {
    const captured = capturedOf(event);
    const problem = captured.kind === 'refused' ? captured.reason : captured.kind === 'key' ? current.request.problemOf(captured.spec) : undefined;
    if (problem !== undefined) {
      change(layer, { ...current, problem });
      return;
    }
    if (captured.kind === 'key' || captured.kind === 'remove') {
      answered(layer);
      current.resolve(captured);
      return;
    }
    left(layer, () => current.resolve(undefined));
  };

  const keptKey = (layer: Layer, event: KeyEvent, keys: KeyTable): void => {
    const action = selectActionOf(event, keys);
    if (action === 'select.escape' || action === 'select.interrupt') layer.scope.steps.at(-1)?.abandon();
  };

  const submitText = (layer: Layer, current: TextOverlay): void => {
    const text = editorOf(layer).text;
    const error = current.request.validate(text);
    if (error !== undefined) {
      change(layer, { ...current, error });
      return;
    }
    answered(layer);
    current.resolve(text);
  };

  const editValueExternally = async (layer: Layer, current: TextOverlay): Promise<void> => {
    const outcome = await host.externalEditor.edit(editorOf(layer).text, 'json');
    const shown = isShown(layer);
    if (shown?.overlay !== current) return;
    if (outcome.kind === 'unset') change(layer, { ...current, error: editorUnsetHint(host.keys) });
    else replaceEditor(layer, placeText(editorOf(layer), outcome.text));
  };

  const structuredKey = (layer: Layer, current: TextOverlay, event: KeyEvent, keys: KeyTable): boolean => {
    const action = keys.actionOf(TEXT_CONTEXTS, event);
    if (action === 'editor.submitValue') submitText(layer, current);
    else if (action === 'editor.external') editValueExternally(layer, current).catch(host.reportError);
    else if (action === 'select.decide') replaceEditor(layer, applyAction(editorOf(layer), 'prompt.newline'));
    else return false;
    return true;
  };

  const textKey = (layer: Layer, current: TextOverlay, event: KeyEvent, keys: KeyTable): void => {
    const action = selectActionOf(event, keys);
    if (action === 'select.escape') {
      left(layer, () => current.resolve(undefined));
      return;
    }
    if (current.request.structured === true && structuredKey(layer, current, event, keys)) return;
    if (action === 'select.decide') {
      submitText(layer, current);
      return;
    }
    replaceEditor(layer, applyKeyEvent(editorOf(layer), event, keys).state);
  };

  const overlayKeyOf = (layer: Layer, event: KeyEvent, keys: KeyTable): void => {
    const current = layer.overlay;
    switch (current.kind) {
      case 'kept':
        keptKey(layer, event, keys);
        return;
      case 'waiting':
        waitingKey(layer, current, event, keys);
        return;
      case 'loading': {
        const action = selectActionOf(event, keys);
        if (action === 'select.escape' || action === 'select.interrupt') current.cancel();
        return;
      }
      case 'capture':
        captureKey(layer, current, event);
        return;
      case 'pick': {
        const active = pickActive(layer, current);
        if (typeof current.request.escape === 'number' && detailOf(active) === undefined && layer.openedIn !== undefined && selectActionOf(event, keys) === 'select.escape') {
          left(layer, () => current.resolve(undefined));
          return;
        }
        selectInput(active, event, keys);
        return;
      }
      case 'text':
        textKey(layer, current, event, keys);
    }
  };

  const keptView = (layer: Layer, kept: Extract<Overlay, { kind: 'kept' }>): ReactNode => {
    const { shown } = kept;
    if (kept.phase !== undefined) return <OverlayView overlay={{ kind: 'loading', title: titleOf(shown), line: kept.phase, hint: LOADING_HINTS.none, cancel: () => undefined }} editor={emptyEditor()} keys={host.keys} columns={host.columns} rows={host.panelRows} />;
    if (shown.kind === 'pick') return selectView(pickActive(layer, shown));
    return <OverlayView overlay={shown} editor={editorOf(layer)} keys={host.keys} columns={host.columns} rows={host.panelRows} />;
  };

  const runScope = async <T,>(raised: string | undefined, work: () => Promise<T>): Promise<T> => {
    scopeCount.current += 1;
    const scope: FlowScope = { id: scopeCount.current, raised, steps: [] };
    liveScopes.current.add(scope);
    try {
      return await inScope(scope, work);
    } finally {
      liveScopes.current.delete(scope);
      const current = layerOf(scope);
      if (current !== undefined) place(scope, undefined);
    }
  };

  const flow = async <T,>(work: () => Promise<T>): Promise<T> => (currentScope() === undefined ? runScope(undefined, work) : work());

  const raise = async (kind: string, work: () => Promise<void>): Promise<void> => {
    if (raising.current.has(kind)) return;
    raising.current.add(kind);
    try {
      await runScope(kind, work);
    } finally {
      raising.current.delete(kind);
    }
  };

  const runPrompt = (): { approval: PendingApproval | undefined; elicitation: PendingElicitation | undefined } => {
    const state = store.state();
    return { elicitation: state.elicitation, approval: state.approval !== undefined && promptTakesFocus(state) ? state.approval : undefined };
  };

  const screenId = (trust: boolean): string => {
    if (trust) return TRUST_OWNER;
    const top = topLayer();
    if (top !== undefined) return `screen:${top.screen}`;
    const { elicitation, approval } = runPrompt();
    if (elicitation !== undefined) {
      const flow = flowOf(elicitation);
      return `input:${elicitation.inputId}:${flow.index}:${flow.stage}:${flow.fieldIndex}`;
    }
    return approval === undefined ? 'prompt' : approvalOwner(approval);
  };

  const isProductPanel = (trust: boolean): boolean => {
    if (trust) return true;
    const top = topLayer();
    if (top !== undefined) return top.scope.raised !== undefined;
    const { elicitation, approval } = runPrompt();
    return elicitation !== undefined || approval !== undefined;
  };

  const undrawnKey = (event: KeyEvent, keys: KeyTable): void => {
    const top = topLayer();
    const action = selectActionOf(event, keys);
    if (top !== undefined) {
      if (top.scope.raised !== undefined) {
        if (layers.current.slice(0, -1).some((layer) => layer.scope.raised !== undefined)) return;
        const underneath = layers.current.findLast((layer) => layer.scope.raised === undefined);
        if (underneath !== undefined) {
          if (action === 'select.escape' || action === 'select.interrupt') overlayKeyOf(underneath, event, keys);
          return;
        }
        const typed = keys.typedOf(event);
        if (typed !== undefined) {
          host.keepTyped(typed);
          return;
        }
        if (action === 'select.interrupt') host.interruptRun();
        else if (action === 'select.escape') host.stopActive();
      }
      return;
    }
    const { elicitation, approval } = runPrompt();
    if (elicitation === undefined && approval === undefined) return;
    const typed = keys.typedOf(event);
    if (typed !== undefined) {
      host.keepTyped(typed);
      return;
    }
    if (action === 'select.interrupt') host.interruptRun();
    else if (action === 'select.escape') host.stopActive();
  };

  const undrawnPaste = (text: string): void => {
    const top = topLayer();
    if (top !== undefined) {
      if (top.scope.raised !== undefined && layers.current.length === 1) host.keepTyped(text);
      return;
    }
    const { elicitation, approval } = runPrompt();
    if (elicitation !== undefined || approval !== undefined) host.keepTyped(text);
  };

  return {
    overlayPorts,
    overlay: topLayer()?.overlay,
    invitation,
    invite: (next) => setInvitation(next),
    dismissInvitation: () => setInvitation(undefined),
    flow,
    raise,
    waitWords,
    screenId,
    isProductPanel,
    undrawnKey,
    undrawnPaste,
    overlayKind: () => topLayer()?.overlay.kind,
    promptStage: () => {
      const state = store.state();
      if (state.elicitation !== undefined) return flowOf(state.elicitation).stage === 'decision' ? 'decision' : 'fields';
      return state.approval === undefined || !promptTakesFocus(state) ? undefined : 'decision';
    },
    detailShown: (facts) => {
      const active = panelActive(facts);
      return active !== undefined && detailOf(active) !== undefined;
    },
    trustKey: (path, event, keys) => selectInput(trustActive(path), event, keys),
    overlayKey: (event, keys) => {
      const top = topLayer();
      if (top === undefined) return false;
      overlayKeyOf(top, event, keys);
      return true;
    },
    runPromptKey: (event, keys) => {
      const state = store.state();
      if (state.elicitation !== undefined) {
        elicitationKey(state.elicitation, event, keys);
        return true;
      }
      if (state.approval !== undefined && promptTakesFocus(state)) {
        selectInput(approvalActive(state.approval), event, keys);
        return true;
      }
      return false;
    },
    paste: (text) => {
      const top = topLayer();
      if (top?.overlay.kind === 'kept') return true;
      if (top?.overlay.kind === 'waiting') {
        if (!top.overlay.delivered) pasteIntoWaiting(top, top.overlay, text);
        return true;
      }
      if (top?.overlay.kind === 'text') {
        replaceEditor(top, insertText(editorOf(top), text));
        return true;
      }
      const state = store.state();
      if (state.elicitation !== undefined) {
        if (state.elicitation.flow.stage === 'fields') replaceElicitEditor(insertText(elicitEditorRef.current, text));
        return true;
      }
      return false;
    },
    panel: (facts) => {
      const active = panelActive(facts);
      if (active !== undefined) return selectView(active);
      const top = topLayer();
      if (top?.overlay.kind === 'kept') return keptView(top, top.overlay);
      if (top !== undefined && top.overlay.kind !== 'pick') return <OverlayView overlay={top.overlay} editor={editorOf(top)} keys={host.keys} columns={host.columns} rows={host.panelRows} />;
      const pending = fieldsShown(facts);
      if (pending === undefined) return undefined;
      return (
        <ElicitationFields
          elicitation={{ ...pending, flow: flowOf(pending) }}
          title={toolOf(store, pending.callId)?.title ?? pending.callId}
          editor={elicitEditorRef.current}
          columns={host.columns}
          waiting={waitingCount(store.state())}
          keys={host.keys}
        />
      );
    },
    press: (facts, row) => {
      const active = panelActive(facts);
      if (active !== undefined) selectPress(active, row);
    },
    hover: (facts, row) => {
      const active = panelActive(facts);
      return active === undefined ? false : selectHoverAt(active, row);
    },
    wheel: (facts, rows) => {
      const active = panelActive(facts);
      if (active !== undefined) selectScroll(active, rows);
    },
  };
};
