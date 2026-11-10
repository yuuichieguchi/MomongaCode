import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Key } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import type { PermissionOption } from '@momonga/protocol';
import { cleanFailureMessage } from '@momonga/foundation';
import { couldNotOpenBrowser } from '../../browser-text.ts';
import { currentRequest, decide, enterValue, leaveFields, withError } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import { PASTED_CALLBACK_MAX_BYTES, pastedCallbackProblem } from '../../plan/sign-in.ts';
import type { TuiBackend } from '../backend.ts';
import { applyKey, emptyEditor } from '../editor.ts';
import type { EditorState } from '../editor.ts';
import { OverlayView } from '../picker.tsx';
import type { Overlay, OverlayPorts, WaitingOverlay } from '../picker.tsx';
import { toolOf, withElicitationFlow } from '../transcript.ts';
import type { Entry, PendingApproval, PendingElicitation } from '../transcript.ts';
import { INVITATION_CHOICES } from './menu.tsx';
import type { Invitation } from './menu.tsx';
import { ApprovalPrompt, decisionChoices, ElicitationPrompt, TRUST_CHOICES, TrustPrompt } from './prompt-panel.tsx';
import type { TrustDecision } from './prompt-panel.tsx';
import type { TranscriptStore } from './store.ts';

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
  cancelNewest(): void;
  reportError(error: unknown): void;
  fail(error: unknown): void;
  exit(): void;
  append(entry: Entry): void;
  decideTrust(decision: TrustDecision): void;
  acceptInvitation(invitation: Invitation): void;
};

export type PanelFacts = { trustPath: string | undefined; ready: boolean; panelRows: number };

export type Prompts = {
  overlayPorts: OverlayPorts;
  overlay: Overlay | undefined;
  closeLoading(): void;
  invitation: Invitation | undefined;
  invitationIndex: number;
  invite(invitation: Invitation): void;
  dismissInvitation(): void;
  trustKey(input: string, key: Key): void;
  overlayKey(input: string, key: Key): boolean;
  invitationKey(input: string, key: Key): boolean;
  runPromptKey(input: string, key: Key): boolean;
  paste(text: string): boolean;
  panel(facts: PanelFacts): ReactNode | undefined;
};

export const usePrompts = (host: PromptsHost): Prompts => {
  const { backend, store } = host;
  const state = store.state();
  const [approvalIndex, setApprovalIndexState] = useState(0);
  const approvalIndexRef = useRef(0);
  const [elicitEditor, setElicitEditor] = useState<EditorState>(emptyEditor());
  const elicitEditorRef = useRef<EditorState>(elicitEditor);
  const flowRef = useRef<{ inputId: string; flow: ElicitationFlow } | undefined>(undefined);
  const [overlay, setOverlayState] = useState<Overlay | undefined>(undefined);
  const overlayRef = useRef<Overlay | undefined>(undefined);
  const [overlayIndex, setOverlayIndexState] = useState(0);
  const overlayIndexRef = useRef(0);
  const [confirming, setConfirmingState] = useState<number | undefined>(undefined);
  const confirmingRef = useRef<number | undefined>(undefined);
  const [overlayEditor, setOverlayEditor] = useState<EditorState>(emptyEditor());
  const overlayEditorRef = useRef<EditorState>(overlayEditor);
  const [invitation, setInvitation] = useState<Invitation | undefined>(undefined);
  const [invitationIndex, setInvitationIndexState] = useState(0);
  const invitationIndexRef = useRef(0);

  const showOverlay = (next: Overlay | undefined): void => {
    overlayRef.current = next;
    setOverlayState(next);
  };

  const setOverlayIndex = (index: number): void => {
    overlayIndexRef.current = index;
    setOverlayIndexState(index);
  };

  const setConfirming = (index: number | undefined): void => {
    confirmingRef.current = index;
    setConfirmingState(index);
  };

  const replaceOverlayEditor = (next: EditorState): void => {
    overlayEditorRef.current = next;
    setOverlayEditor(next);
  };

  const setInvitationIndex = (index: number): void => {
    invitationIndexRef.current = index;
    setInvitationIndexState(index);
  };

  const setApprovalIndex = (index: number): void => {
    approvalIndexRef.current = index;
    setApprovalIndexState(index);
  };

  const replaceElicitEditor = (next: EditorState): void => {
    elicitEditorRef.current = next;
    setElicitEditor(next);
  };

  const promptKey = state.approval?.approvalId ?? state.elicitation?.inputId;
  const [selectionOwner, setSelectionOwner] = useState(promptKey);
  if (selectionOwner !== promptKey) {
    setSelectionOwner(promptKey);
    setApprovalIndex(0);
  }

  const overlayPorts: OverlayPorts = {
    pick: (request) =>
      new Promise((resolve) => {
        setOverlayIndex(0);
        setConfirming(undefined);
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

  const resolveApproval = (approval: PendingApproval, option: PermissionOption | undefined): void => {
    if (option === undefined) return;
    backend.resolveApproval(approval.approvalId, option.optionId).catch(host.reportError);
  };

  const flowOf = (pending: PendingElicitation): ElicitationFlow => (flowRef.current?.inputId === pending.inputId ? flowRef.current.flow : pending.flow);

  const applyFlow = (pending: PendingElicitation, flow: ElicitationFlow, submitted = false): void => {
    flowRef.current = { inputId: pending.inputId, flow };
    setApprovalIndex(0);
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

  const elicitationKey = (pending: PendingElicitation, input: string, key: Key): void => {
    if (isInterrupt(input, key)) {
      host.cancelNewest();
      return;
    }
    if (pending.submitted) return;
    const flow = flowOf(pending);
    if (flow.stage === 'decision') {
      const choices = decisionChoices(flow);
      if (key.escape) host.cancelNewest();
      else if (key.upArrow) setApprovalIndex((approvalIndexRef.current + choices.length - 1) % choices.length);
      else if (key.downArrow) setApprovalIndex((approvalIndexRef.current + 1) % choices.length);
      else if (key.return) decideFlow(pending, choices[approvalIndexRef.current]?.decision);
      else if (/^[1-9]$/.test(input)) decideFlow(pending, choices[Number(input) - 1]?.decision);
      return;
    }
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

  const approvalKey = (approval: PendingApproval, input: string, key: Key): void => {
    if (key.escape || isInterrupt(input, key)) {
      host.cancelNewest();
      return;
    }
    if (key.upArrow) setApprovalIndex((approvalIndexRef.current + approval.options.length - 1) % approval.options.length);
    else if (key.downArrow) setApprovalIndex((approvalIndexRef.current + 1) % approval.options.length);
    else if (key.return) resolveApproval(approval, approval.options[approvalIndexRef.current]);
    else if (/^[1-9]$/.test(input)) resolveApproval(approval, approval.options[Number(input) - 1]);
  };

  const closeOverlay = (): void => {
    showOverlay(undefined);
    setConfirming(undefined);
  };

  const choosePick = (current: Extract<Overlay, { kind: 'pick' }>, index: number): void => {
    const row = current.request.rows[index];
    if (row === undefined || row.disabled === true) return;
    setOverlayIndex(index);
    if (current.request.confirm !== undefined && confirmingRef.current !== index) {
      setConfirming(index);
      return;
    }
    closeOverlay();
    current.resolve(index);
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
      const count = current.request.rows.length;
      if (key.escape) {
        closeOverlay();
        current.resolve(undefined);
      } else if (key.upArrow) {
        setConfirming(undefined);
        setOverlayIndex((overlayIndexRef.current + count - 1) % count);
      } else if (key.downArrow) {
        setConfirming(undefined);
        setOverlayIndex((overlayIndexRef.current + 1) % count);
      } else if (key.return) choosePick(current, overlayIndexRef.current);
      else if (/^[1-9]$/.test(input)) choosePick(current, Number(input) - 1);
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
    invitationIndex,
    invite: (next) => {
      setInvitationIndex(0);
      setInvitation(next);
    },
    dismissInvitation: () => {
      if (invitation !== undefined) setInvitation(undefined);
    },
    trustKey: (input, key) => {
      if (key.escape || isInterrupt(input, key)) {
        host.exit();
        return;
      }
      const choice = TRUST_CHOICES.find((candidate) => candidate.key === input);
      if (choice !== undefined) host.decideTrust(choice.decision);
    },
    overlayKey: (input, key) => {
      const current = overlayRef.current;
      if (current === undefined) return false;
      overlayKeyOf(current, input, key);
      return true;
    },
    invitationKey: (input, key) => {
      if (invitation === undefined) return false;
      const act = (index: number): void => {
        setInvitation(undefined);
        if (index === 0) host.acceptInvitation(invitation);
        else backend.dismissNotice(`invite:${invitation.profile.id}`).catch(host.reportError);
      };
      if (key.upArrow) setInvitationIndex((invitationIndexRef.current + INVITATION_CHOICES - 1) % INVITATION_CHOICES);
      else if (key.downArrow) setInvitationIndex((invitationIndexRef.current + 1) % INVITATION_CHOICES);
      else if (key.return) act(invitationIndexRef.current);
      else if (/^[1-2]$/.test(input)) act(Number(input) - 1);
      else return false;
      return true;
    },
    runPromptKey: (input, key) => {
      if (state.elicitation !== undefined) {
        elicitationKey(state.elicitation, input, key);
        return true;
      }
      if (state.approval !== undefined) {
        approvalKey(state.approval, input, key);
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
      if (state.elicitation !== undefined) {
        if (state.elicitation.flow.stage === 'fields') replaceElicitEditor(applyKey(elicitEditorRef.current, { input: text }).state);
        return true;
      }
      return false;
    },
    panel: ({ trustPath, ready, panelRows }) => {
      if (trustPath !== undefined) return <TrustPrompt path={trustPath} />;
      if (overlay !== undefined) return <OverlayView overlay={overlay} selected={overlayIndex} confirming={confirming} editor={overlayEditor} />;
      if (!ready) return undefined;
      if (state.elicitation !== undefined) {
        const title = toolOf(store, state.elicitation.callId)?.title ?? state.elicitation.callId;
        return <ElicitationPrompt elicitation={state.elicitation} title={title} editor={elicitEditor} selected={approvalIndex} />;
      }
      if (state.approval !== undefined) return <ApprovalPrompt approval={state.approval} tool={toolOf(store, state.approval.callId)} selected={approvalIndex} workingDirectory={backend.cwd} panelRows={panelRows} />;
      return undefined;
    },
  };
};
