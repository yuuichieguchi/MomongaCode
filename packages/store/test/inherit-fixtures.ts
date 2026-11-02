import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { InputItem, PermissionMode, RunEventPayload, RunState, StopReason } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { materializeEvents } from '@momonga/testkit';

export const SOURCE_RUN = 'run-source';
export const NEXT_RUN = 'run-next';
export const SESSION = 'sess-inherit';

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

type HistoryEntry = RunState['history'][number];

export type InheritedEvent = Extract<RunEventPayload, { type: 'context.inherited' }>;

export const foldOf = (payloads: readonly RunEventPayload[], runId = SOURCE_RUN): RunState =>
  materializeEvents(payloads, { runId, sessionId: SESSION }).reduce(foldRunState, initialRunState({ runId, sessionId: SESSION }));

export const task = (text: string): RunEventPayload => ({ type: 'user.message', text });

export const taskItem = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

export const claimed = (mode?: PermissionMode): RunEventPayload[] => [
  { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' }, ...(mode === undefined ? {} : { mode }) },
];

export const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { tool_choice: 'auto' } });

export const responded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: USAGE },
});

export const assistantItem = (id: string, text: string) => ({
  type: 'message' as const,
  id,
  role: 'assistant' as const,
  status: 'completed' as const,
  content: [{ type: 'output_text' as const, text, annotations: [] }],
});

export const callItem = (callId: string) => ({
  type: 'function_call' as const,
  id: `fc_${callId}`,
  call_id: callId,
  name: 'Write',
  arguments: '{"file_path":"/work/a/x.txt"}',
  status: 'completed' as const,
});

export const toolCall = (callId: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name: 'Write',
  kind: 'edit',
  title: 'Write x.txt',
  rawInput: { file_path: '/work/a/x.txt' },
});

export const toolDone = (callId: string, output: string): RunEventPayload[] => [
  { type: 'tool.started', callId, idemKey: `k-${callId}` },
  { type: 'tool.completed', callId, status: 'completed', output },
];

export const ended = (to: 'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED', reason?: string): RunEventPayload => ({
  type: 'run.status',
  from: 'RUNNING',
  to,
  ...(reason === undefined ? {} : { reason }),
});

export const CLOSURE_TEXT = {
  cancelled: 'Not run: the user interrupted the previous request before this tool call ran.',
  approvalTimeout: 'Not run: approval for this tool call was not given in time.',
  loop: 'Not run: the previous request was stopped because the same tool call kept repeating.',
  timeout: 'Not run: the previous request ran out of time before this tool call ran.',
  failed: 'Not run: the previous request ended with an error before this tool call ran.',
  other: 'Not run: the previous request was stopped before this tool call ran.',
} as const;

export const startedClosureText = (phrase: string): string =>
  `This tool call had started when the previous request ${phrase}. Its result was not recorded and its effect is unknown; inspect the current state before retrying it.`;

export const MARKER_TEXT = {
  userInterrupted: '[The user interrupted the previous request before it was finished.]',
  ended: '[The previous request ended before it was finished.]',
  unprocessed: '[The previous request was never processed: it timed out while waiting in the queue.]',
  dropped: '[A previous message was too large to process and was dropped.]',
} as const;

export const MODE_RULE: Record<PermissionMode, string> = {
  default:
    "File changes and commands need the user's approval unless an allow rule covers them; read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, ps, sort and read-only git) run without asking.",
  acceptEdits:
    'File edits and the filesystem commands mkdir, touch, rm, rmdir, mv, cp and sed inside the workspace are accepted without asking, and read-only commands run without asking; other actions still need approval unless an allow rule covers them.',
  plan: "Do not edit files; research and propose a plan for the user to approve. Read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, ps, sort and read-only git) run without asking; any other command needs the user's approval unless an allow rule covers it.",
  auto: "Tool calls that would need approval are first reviewed by an automatic safety classifier; calls it does not clearly approve still need the user's approval. Stay within what the user asked.",
  bypassPermissions: 'Tool calls run without asking the user; be careful with destructive actions.',
};

export const modeChangedText = (from: PermissionMode, to: PermissionMode): string =>
  `[The permission mode changed from ${from} to ${to}. ${MODE_RULE[to]} The set of available tools may differ from earlier in this conversation.]`;

export const markerEntry = (seq: number, text: string): HistoryEntry => ({ seq, item: { type: 'message', role: 'user', content: text } });

export const closureEntry = (seq: number, callId: string, text: string): HistoryEntry => ({
  seq,
  item: { type: 'function_call_output', call_id: callId, output: text },
  callId,
});

export const partialEntry = (seq: number, text: string): HistoryEntry => ({
  seq,
  item: { type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text, annotations: [] }] },
});

export const inheritedDigest = (payload: Pick<InheritedEvent, 'history' | 'nextItemSeq' | 'summary' | 'evicted' | 'mode' | 'activatedSkills'>): string =>
  sha256Hex(
    canonicalJson({
      history: payload.history,
      nextItemSeq: payload.nextItemSeq,
      summary: payload.summary ?? null,
      evicted: payload.evicted,
      mode: payload.mode ?? null,
      ...(payload.activatedSkills === undefined ? {} : { activatedSkills: payload.activatedSkills }),
    }),
  );

export const inheritedEvent = (fields: Omit<InheritedEvent, 'type' | 'digest' | 'closures' | 'markers' | 'evicted'> & Partial<Pick<InheritedEvent, 'closures' | 'markers' | 'evicted'>>): InheritedEvent => {
  const base = { closures: [], markers: [], evicted: [], ...fields };
  return { type: 'context.inherited', ...base, digest: inheritedDigest(base) };
};

export const hasConsistentSeqs = (payload: Pick<InheritedEvent, 'history' | 'nextItemSeq' | 'summary'>): boolean => {
  const seqs = payload.history.map((entry) => entry.seq);
  if (!seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number))) return false;
  if (!Number.isInteger(payload.nextItemSeq) || payload.nextItemSeq < 1) return false;
  const last = seqs.at(-1);
  if (last !== undefined && payload.nextItemSeq <= last) return false;
  const first = seqs[0];
  if (payload.summary !== undefined && first !== undefined && payload.summary.replacedThroughSeq >= first) return false;
  return true;
};

export const pairsEveryCall = (history: readonly HistoryEntry[]): boolean => {
  const open = new Set<string>();
  for (const { item } of history) {
    if (item.type === 'function_call') open.add(item.call_id);
    if (item.type === 'function_call_output') {
      if (!open.has(item.call_id)) return false;
      open.delete(item.call_id);
    }
  }
  return open.size === 0;
};

export const hasAdjacentAssistants = (history: readonly HistoryEntry[]): boolean =>
  history.some(
    (entry, index) =>
      index > 0 &&
      entry.item.type === 'message' &&
      entry.item.role === 'assistant' &&
      history[index - 1]?.item.type === 'message' &&
      (history[index - 1]?.item as { role?: string }).role === 'assistant',
  );

export type Outcome = { status: 'COMPLETED' | 'STOPPED' | 'FAILED' | 'CANCELLED'; stopReason?: StopReason; errorCode?: string; carriedSkills?: readonly string[] };
