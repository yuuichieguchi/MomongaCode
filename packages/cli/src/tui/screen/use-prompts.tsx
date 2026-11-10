import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Key } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import { cleanFailureMessage } from '@momonga/foundation';
import { couldNotOpenBrowser } from '../../browser-text.ts';
import { currentRequest, decide, enterValue, leaveFields, withError } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import { PASTED_CALLBACK_MAX_BYTES, pastedCallbackProblem } from '../../plan/sign-in.ts';
import type { TuiBackend } from '../backend.ts';
import { applyKey, emptyEditor } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { OverlayView, pickerSpec } from '../picker.tsx';
import type { Overlay, OverlayPorts, WaitingOverlay } from '../picker.tsx';
import { detailCapacity, detailTop, DetailView, selectClick, selectKey, selectLayout, selectRowAt, selectStart, selectText, SelectView, selectWheel } from '../select.tsx';
import type { SelectFrame, SelectLayout, SelectLine, SelectOutcome, SelectSpec, SelectState, SelectStep, TextRow } from '../select.tsx';
import type { TerminalEvent } from '../terminal/events.ts';
import { toolOf, withElicitationFlow } from '../transcript.ts';
import type { Entry, PendingApproval, PendingElicitation } from '../transcript.ts';
import { WHEEL_ROWS } from './constants.ts';
import type { ScreenTerminal } from './input.ts';
import { regionAt } from './layout.ts';
import type { RowAllocation } from './layout.ts';
import { INVITATION_ACCEPT, invitationSpec } from './menu.tsx';
import type { Invitation } from './menu.tsx';
import { approvalLines, approvalSpec, decisionChoices, ElicitationFields, elicitationSpec, TRUST_CHOICES, trustSpec } from './prompt-panel.tsx';
import type { TrustDecision } from './prompt-panel.tsx';
import type { TranscriptState, TranscriptStore } from './store.ts';

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

const isInterrupt = (input: string, key: Key): boolean => key.ctrl && input === 'c';

export type PromptsHost = {
  backend: TuiBackend;
  store: TranscriptStore;
  columns: number;
  panelRows: number;
  cancelNewest(): void;
  reportError(error: unknown): void;
  fail(error: unknown): void;
  exit(): void;
  append(entry: Entry): void;
  decideTrust(decision: TrustDecision): void;
  acceptInvitation(invitation: Invitation): void;
};

export type PanelFacts = { trustPath: string | undefined; ready: boolean };

export type Prompts = {
  overlayPorts: OverlayPorts;
  overlay: Overlay | undefined;
  closeLoading(): void;
  invitation: Invitation | undefined;
  invitationRows: number;
  invitationView(): ReactNode;
  invitationPress(row: number): void;
  invite(invitation: Invitation): void;
  dismissInvitation(): void;
  trustKey(path: string, input: string, key: Key): void;
  overlayKey(input: string, key: Key): boolean;
  invitationKey(input: string, key: Key): boolean;
  runPromptKey(input: string, key: Key): boolean;
  paste(text: string): boolean;
  panel(facts: PanelFacts): ReactNode | undefined;
  press(facts: PanelFacts, row: number): void;
  wheel(facts: PanelFacts, rows: number): void;
};

type Active = { owner: string; spec: SelectSpec; border: boolean; sending: boolean; on(outcome: SelectOutcome): void };

const TRUST_OWNER = 'trust';

const DIGIT = /^[1-9]$/;

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
  useEffect(() => terminal.input.claim((event) => onEvent(event)), [terminal]);
};

export const usePrompts = (host: PromptsHost): Prompts => {
  const { backend, store } = host;
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const selection = useRef<{ owner: string; state: SelectState } | undefined>(undefined);
  const sent = useRef<string | undefined>(undefined);
  const failed = useRef<{ owner: string; text: string } | undefined>(undefined);
  const detail = useRef<{ owner: string; top: number } | undefined>(undefined);
  const texts = useRef<{ owner: string; width: number; title: string | undefined; rows: TextRow[] } | undefined>(undefined);
  const approvalText = useRef<{ approvalId: string; title: string; lines: SelectLine[] } | undefined>(undefined);
  const pickId = useRef(0);
  const flowGeneration = useRef(0);
  const [elicitEditor, setElicitEditor] = useState<EditorState>(emptyEditor());
  const elicitEditorRef = useRef<EditorState>(elicitEditor);
  const flowRef = useRef<{ inputId: string; flow: ElicitationFlow } | undefined>(undefined);
  const [overlay, setOverlayState] = useState<Overlay | undefined>(undefined);
  const overlayRef = useRef<Overlay | undefined>(undefined);
  const [overlayEditor, setOverlayEditor] = useState<EditorState>(emptyEditor());
  const overlayEditorRef = useRef<EditorState>(overlayEditor);
  const [invitation, setInvitation] = useState<Invitation | undefined>(undefined);

  const showOverlay = (next: Overlay | undefined): void => {
    overlayRef.current = next;
    setOverlayState(next);
  };

  const replaceOverlayEditor = (next: EditorState): void => {
    overlayEditorRef.current = next;
    setOverlayEditor(next);
  };

  const replaceElicitEditor = (next: EditorState): void => {
    elicitEditorRef.current = next;
    setElicitEditor(next);
  };

  const overlayPorts: OverlayPorts = {
    pick: (request) =>
      new Promise((resolve) => {
        pickId.current += 1;
        showOverlay({ kind: 'pick', request, resolve });
      }),
    promptText: (request) =>
      new Promise((resolve) => {
        const initial = request.initial ?? '';
        replaceOverlayEditor({ ...emptyEditor(), text: initial, cursor: initial.length });
        showOverlay({ kind: 'text', request, resolve });
      }),
    waiting: (view, handlers) => {
      const current = overlayRef.current;
      if (current?.kind === 'waiting') {
        showOverlay({ ...current, view, handlers });
        return;
      }
      replaceOverlayEditor(emptyEditor());
      showOverlay({ kind: 'waiting', view, handlers, delivered: false });
    },
    delivered: () => {
      const current = overlayRef.current;
      if (current?.kind !== 'waiting' || current.delivered) return;
      replaceOverlayEditor(emptyEditor());
      const { problem: _problem, status: _status, ...rest } = current;
      showOverlay({ ...rest, delivered: true });
    },
    closeWaiting: () => {
      if (overlayRef.current?.kind === 'waiting') showOverlay(undefined);
    },
    loading: (title) => showOverlay({ kind: 'loading', title }),
  };

  const stateOf = (active: Active): SelectState => (selection.current?.owner === active.owner ? selection.current.state : selectStart(active.spec));

  const frameOf = (active: Active): SelectFrame => ({ width: host.columns, rows: host.panelRows, border: active.border });

  const textOf = (active: Active): readonly TextRow[] => {
    const frame = frameOf(active);
    const kept = texts.current;
    if (kept !== undefined && kept.owner === active.owner && kept.width === frame.width && kept.title === active.spec.title) return kept.rows;
    const rows = selectText(active.spec, frame);
    texts.current = { owner: active.owner, width: frame.width, title: active.spec.title, rows };
    return rows;
  };

  const errorFor = (active: Active): string | undefined => (failed.current?.owner === active.owner ? failed.current.text : undefined);

  const layoutOf = (active: Active): SelectLayout => selectLayout(active.spec, stateOf(active), textOf(active), frameOf(active), errorFor(active) === undefined ? 0 : 1);

  const detailOf = (active: Active): { owner: string; top: number } | undefined => (detail.current?.owner === active.owner ? detail.current : undefined);

  const apply = (active: Active, step: SelectStep): void => {
    selection.current = { owner: active.owner, state: step.state };
    redraw();
    if (step.outcome !== undefined) active.on(step.outcome);
  };

  const scrollDetail = (active: Active, top: number): void => {
    detail.current = { owner: active.owner, top: detailTop(textOf(active), frameOf(active), top) };
    redraw();
  };

  const detailKey = (active: Active, shown: { top: number }, key: Key): void => {
    const page = detailCapacity(frameOf(active));
    if (key.escape) {
      detail.current = undefined;
      redraw();
    } else if (key.upArrow) scrollDetail(active, shown.top - 1);
    else if (key.downArrow) scrollDetail(active, shown.top + 1);
    else if (key.pageUp) scrollDetail(active, shown.top - page);
    else if (key.pageDown) scrollDetail(active, shown.top + page);
  };

  const selectInput = (active: Active, input: string, key: Key): void => {
    if (isInterrupt(input, key)) {
      active.on({ kind: 'interrupt', action: active.spec.interrupt });
      return;
    }
    if (active.sending) return;
    const shown = detailOf(active);
    if (shown !== undefined) {
      detailKey(active, shown, key);
      return;
    }
    const layout = layoutOf(active);
    if (key.ctrl && input === 'o') {
      if (layout.more > 0) scrollDetail(active, 0);
      return;
    }
    apply(active, selectKey(active.spec, stateOf(active), input, key, layout.capacity));
  };

  const selectPress = (active: Active, row: number): void => {
    if (active.sending || detailOf(active) !== undefined) return;
    const index = selectRowAt(layoutOf(active), row);
    if (index !== undefined) apply(active, selectClick(active.spec, stateOf(active), index));
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
    if (shown !== undefined) return <DetailView text={textOf(active)} frame={frameOf(active)} top={shown.top} />;
    const error = errorFor(active);
    return <SelectView spec={active.spec} state={stateOf(active)} layout={layoutOf(active)} border={active.border} sending={active.sending} {...(error === undefined ? {} : { error })} />;
  };

  const markSent = (owner: string): void => {
    sent.current = owner;
    failed.current = undefined;
    redraw();
  };

  const approvalTextOf = (approval: PendingApproval): { title: string; lines: SelectLine[] } => {
    const kept = approvalText.current;
    if (kept !== undefined && kept.approvalId === approval.approvalId) return kept;
    const tool = toolOf(store, approval.callId);
    const next = { approvalId: approval.approvalId, title: tool?.title ?? approval.callId, lines: approvalLines(approval, tool, backend.cwd) };
    approvalText.current = next;
    return next;
  };

  const approvalActive = (approval: PendingApproval): Active => {
    const owner = `approval:${approval.approvalId}`;
    const { title, lines } = approvalTextOf(approval);
    return {
      owner,
      spec: approvalSpec(approval, title, lines, waitingCount(store.state())),
      border: true,
      sending: sent.current === owner,
      on: (outcome) => {
        if (outcome.kind === 'interrupt') {
          host.cancelNewest();
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
        backend.openUrl(new URL(request.url), undefined, (message) => {
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
        if (outcome.kind === 'interrupt') host.cancelNewest();
        else if (outcome.kind === 'decide') decideFlow(pending, decisionChoices(flow)[outcome.index]?.decision);
      },
    };
  };

  const elicitationKey = (pending: PendingElicitation, input: string, key: Key): void => {
    const flow = flowOf(pending);
    if (flow.stage === 'decision') {
      selectInput(elicitationActive(pending), input, key);
      return;
    }
    if (isInterrupt(input, key)) {
      host.cancelNewest();
      return;
    }
    if (pending.submitted) return;
    if (key.escape) {
      applyFlow(pending, leaveFields(flow));
      return;
    }
    if (key.return && elicitEditorRef.current.text === '') {
      enterValue(flow, '').then((next) => proceedFlow(pending, next), host.fail);
      return;
    }
    const outcome = applyKey(elicitEditorRef.current, { ...key, input });
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

  const closeOverlay = (): void => showOverlay(undefined);

  const pickActive = (current: Extract<Overlay, { kind: 'pick' }>): Active => ({
    owner: `pick:${pickId.current}`,
    spec: pickerSpec(current.request),
    border: true,
    sending: false,
    on: (outcome) => {
      if (outcome.kind === 'alt') return;
      closeOverlay();
      current.resolve(outcome.kind === 'decide' ? outcome.index : undefined);
    },
  });

  const invitationActive = (shown: Invitation): Active => ({
    owner: `invite:${shown.profile.id}`,
    spec: invitationSpec(shown),
    border: false,
    sending: false,
    on: (outcome) => {
      if (outcome.kind === 'alt') return;
      setInvitation(undefined);
      if (outcome.kind !== 'decide') return;
      if (outcome.index === INVITATION_ACCEPT) host.acceptInvitation(shown);
      else backend.dismissNotice(`invite:${shown.profile.id}`).catch(host.reportError);
    },
  });

  const invitationActs = (input: string, key: Key): boolean =>
    key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end || key.return || key.escape || (key.ctrl && (input === 'c' || input === 'p' || input === 'n')) || (!key.ctrl && !key.meta && DIGIT.test(input));

  const panelActive = ({ trustPath, ready }: PanelFacts): Active | undefined => {
    if (trustPath !== undefined) return trustActive(trustPath);
    const current = overlayRef.current;
    if (current !== undefined) return current.kind === 'pick' ? pickActive(current) : undefined;
    if (!ready) return undefined;
    const state = store.state();
    if (state.elicitation !== undefined) return flowOf(state.elicitation).stage === 'decision' ? elicitationActive(state.elicitation) : undefined;
    return state.approval === undefined ? undefined : approvalActive(state.approval);
  };

  const editWaiting = (current: WaitingOverlay, key: Parameters<typeof applyKey>[1]): void => {
    const before = overlayEditorRef.current;
    const room = WAITING_INPUT_BYTES - Buffer.byteLength(before.text, 'utf8');
    const fitted = key.ctrl === true || key.meta === true ? key : { ...key, input: prefixWithin(key.input, room) };
    const after = applyKey(before, fitted).state;
    replaceOverlayEditor(after);
    if (after.text === before.text) return;
    if (current.problem !== undefined) {
      const { problem: _problem, ...rest } = current;
      showOverlay(rest);
    }
  };

  const submitWaiting = (current: WaitingOverlay): void => {
    const text = overlayEditorRef.current.text;
    if (text.trim() === '') return;
    const problem = pastedCallbackProblem(text, current.view.state);
    replaceOverlayEditor(emptyEditor());
    if (problem !== undefined) {
      showOverlay({ ...current, problem });
      return;
    }
    current.handlers.deliver(text);
  };

  const waitingKey = (current: WaitingOverlay, input: string, key: Key): void => {
    if (current.delivered) return;
    if (key.escape || isInterrupt(input, key)) current.handlers.cancel();
    else if (key.ctrl && input === 'y') {
      backend.copyToClipboard(current.view.url.href).catch(host.reportError);
      showOverlay({ ...current, status: CLIPBOARD_ASKED });
    } else if (key.return) submitWaiting(current);
    else editWaiting(current, { ...key, input });
  };

  const overlayKeyOf = (current: Overlay, input: string, key: Key): void => {
    if (current.kind === 'waiting') {
      waitingKey(current, input, key);
      return;
    }
    if (current.kind === 'loading') return;
    if (current.kind === 'pick') {
      selectInput(pickActive(current), input, key);
      return;
    }
    if (key.escape) {
      closeOverlay();
      current.resolve(undefined);
      return;
    }
    if (key.return) {
      const text = overlayEditorRef.current.text;
      const error = current.request.validate(text);
      if (error !== undefined) {
        showOverlay({ ...current, error });
        return;
      }
      closeOverlay();
      current.resolve(text);
      return;
    }
    replaceOverlayEditor(applyKey(overlayEditorRef.current, { ...key, input }).state);
  };

  return {
    overlayPorts,
    overlay,
    closeLoading: () => {
      if (overlayRef.current?.kind === 'loading') showOverlay(undefined);
    },
    invitation,
    invitationRows: invitation === undefined ? 0 : textOf(invitationActive(invitation)).length + invitationSpec(invitation).rows.length + 1,
    invitationView: () => (invitation === undefined ? null : selectView(invitationActive(invitation))),
    invitationPress: (row) => {
      if (invitation !== undefined) selectPress(invitationActive(invitation), row);
    },
    invite: (next) => setInvitation(next),
    dismissInvitation: () => {
      if (invitation !== undefined) setInvitation(undefined);
    },
    trustKey: (path, input, key) => selectInput(trustActive(path), input, key),
    overlayKey: (input, key) => {
      const current = overlayRef.current;
      if (current === undefined) return false;
      overlayKeyOf(current, input, key);
      return true;
    },
    invitationKey: (input, key) => {
      if (invitation === undefined || !invitationActs(input, key)) return false;
      selectInput(invitationActive(invitation), input, key);
      return true;
    },
    runPromptKey: (input, key) => {
      const state = store.state();
      if (state.elicitation !== undefined) {
        elicitationKey(state.elicitation, input, key);
        return true;
      }
      if (state.approval !== undefined) {
        selectInput(approvalActive(state.approval), input, key);
        return true;
      }
      return false;
    },
    paste: (text) => {
      const pastedInto = overlayRef.current;
      if (pastedInto?.kind === 'waiting') {
        if (!pastedInto.delivered) editWaiting(pastedInto, { input: text });
        return true;
      }
      const state = store.state();
      if (state.elicitation !== undefined) {
        if (state.elicitation.flow.stage === 'fields') replaceElicitEditor(applyKey(elicitEditorRef.current, { input: text }).state);
        return true;
      }
      return false;
    },
    panel: (facts) => {
      const active = panelActive(facts);
      if (active !== undefined) return selectView(active);
      if (overlay !== undefined && overlay.kind !== 'pick') return <OverlayView overlay={overlay} editor={overlayEditor} />;
      const pending = facts.ready && facts.trustPath === undefined && overlay === undefined ? store.state().elicitation : undefined;
      if (pending === undefined) return undefined;
      return <ElicitationFields elicitation={{ ...pending, flow: flowOf(pending) }} title={toolOf(store, pending.callId)?.title ?? pending.callId} editor={elicitEditor} waiting={waitingCount(store.state())} />;
    },
    press: (facts, row) => {
      const active = panelActive(facts);
      if (active !== undefined) selectPress(active, row);
    },
    wheel: (facts, rows) => {
      const active = panelActive(facts);
      if (active !== undefined) selectScroll(active, rows);
    },
  };
};
