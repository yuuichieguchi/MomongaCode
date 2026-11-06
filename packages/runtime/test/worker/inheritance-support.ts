import { expect } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { InheritedCopyPayload, InputItem, PermissionMode, RunEvent, RunEventPayload } from '@momonga/protocol';
import type { Run } from '@momonga/store';
import { FLOOR_TOKENS, UNBOUNDED_WINDOW, withReader } from '../../../store/test/support/reference.ts';
import { textOf } from './harness.ts';
import type { Env } from './harness.ts';

export const NEUTRAL_MESSAGE = 'The previous conversation could not be loaded. Start a new conversation (/clear) to continue.';

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
    "File changes and commands need the user's approval unless an allow rule covers them; read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, sort, ps on Linux and read-only git) run without asking.",
  acceptEdits:
    'File edits and the filesystem commands mkdir, touch, rm, rmdir, mv, cp and sed inside the workspace are accepted without asking, and read-only commands run without asking; other actions still need approval unless an allow rule covers them.',
  plan: "Do not edit files; research and propose a plan for the user to approve. Read-only commands (ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, file, sort, ps on Linux and read-only git) run without asking; any other command needs the user's approval unless an allow rule covers it.",
  auto: "Tool calls that would need approval are first reviewed by an automatic safety classifier; calls it does not clearly approve still need the user's approval. Stay within what the user asked.",
  bypassPermissions: 'Tool calls run without asking the user; be careful with destructive actions.',
};

export const modeChangedText = (from: PermissionMode, to: PermissionMode): string =>
  `[The permission mode changed from ${from} to ${to}. ${MODE_RULE[to]} The set of available tools may differ from earlier in this conversation.]`;

export const MODE_CHANGED_PREFIX = '[The permission mode changed from ';

export type InheritedPayload = InheritedCopyPayload;

export type Turn = readonly (string | undefined)[];

export const describeItem = (item: InputItem): Turn => {
  if (item.type === 'message') return item.status === 'incomplete' ? [item.role, textOf(item), 'incomplete'] : [item.role, textOf(item)];
  if (item.type === 'function_call') return ['call', item.name, item.call_id];
  if (item.type === 'function_call_output') return ['output', item.call_id, typeof item.output === 'string' ? item.output : textOf({ content: item.output })];
  return [item.type];
};

export const requestInputs = (env: Env, runId: string): InputItem[][] =>
  env.ofType(runId, 'model.requested').map((event) => (event.body as { input: InputItem[] }).input);

export const firstRequestInput = (env: Env, runId: string): InputItem[] => {
  const [first] = requestInputs(env, runId);
  if (first === undefined) throw new Error(`run ${runId} has no model.requested`);
  return first;
};

export const envNeutralJson = (env: Env, value: unknown): string => canonicalJson(value).split(env.root).join('<env-root>');

export const conversationOf = (input: readonly InputItem[]): Turn[] =>
  input.filter((item) => !(item.type === 'message' && (item.role === 'system' || item.role === 'developer'))).map(describeItem);

export const firstConversation = (env: Env, runId: string): Turn[] => conversationOf(firstRequestInput(env, runId));

export const inheritedEventOf = (env: Env, runId: string): RunEvent & InheritedPayload => {
  const found = env.events(runId).filter((event) => event.type === 'context.inherited');
  expect(found, `context.inherited of run ${runId}`).toHaveLength(1);
  return found[0] as unknown as RunEvent & InheritedPayload;
};

export const resolvedInheritedOf = (env: Env, runId: string): RunEvent & InheritedPayload => {
  const reference = inheritedEventOf(env, runId);
  const window = withReader(env.dbPath, (reader) => reader.readInheritedWindow({ runId, windowTokens: UNBOUNDED_WINDOW, floorTokens: FLOOR_TOKENS }));
  return { ...reference, history: window.entries, evicted: window.evicted, ...(window.summary === undefined ? {} : { summary: window.summary }) } as unknown as RunEvent & InheritedPayload;
};

export const modeMarkersOf = (history: readonly { item: InputItem }[]): string[] =>
  history.flatMap(({ item }) => (item.type === 'message' && item.role === 'user' && textOf(item).startsWith(MODE_CHANGED_PREFIX) ? [textOf(item)] : []));

export const TERMINAL = ['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'] as const;

export const settle = async (env: Env, runId: string, worker = env.worker()): Promise<Run> => {
  for (let round = 0; round < 6; round += 1) {
    const current = env.run(runId);
    if ((TERMINAL as readonly string[]).includes(current.status)) return current;
    await env.runOnce(worker);
  }
  const final = env.run(runId);
  if (!(TERMINAL as readonly string[]).includes(final.status)) throw new Error(`run ${runId} did not settle: ${final.status}`);
  return final;
};

export const plantUnreadableEvent = (env: Env, runId: string, seq: number): void => {
  const db = env.raw();
  db.exec('DROP TRIGGER IF EXISTS events_reject_update');
  db.prepare('DELETE FROM snapshots WHERE run_id = ? AND seq >= ?').run(runId, seq);
  const covering = db.prepare('SELECT MAX(seq) AS seq FROM snapshots WHERE run_id = ?').get(runId) as { seq: number | null };
  expect(covering.seq ?? 0, `latest snapshot of run ${runId} must precede the planted seq`).toBeLessThan(seq);
  db.prepare(`UPDATE events SET type = 'made.up', payload_json = '{"type":"made.up"}' WHERE run_id = ? AND seq = ?`).run(runId, seq);
};
