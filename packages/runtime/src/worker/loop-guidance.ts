import { canonicalJson, isRecord, parseBoundedJson } from '@momonga/foundation';
import { LOOP_GROUPS_KEPT } from '@momonga/protocol';
import type { InputItem, RunState } from '@momonga/protocol';

export const LOOP_GUIDANCE_CALL_CHARS = 200;

export type LoopGuidanceCall = { name: string; arguments: unknown };

export type LoopGuidanceFacts = {
  repeated: LoopGuidanceCall;
  count: number;
  distinctCalls: readonly LoopGuidanceCall[];
  failedCommands: readonly string[];
};

export type CallResult = 'completed' | 'failed';

const CUT_MARK = '...';

const cut = (text: string): string => {
  const characters = Array.from(text);
  return characters.length <= LOOP_GUIDANCE_CALL_CHARS ? text : `${characters.slice(0, LOOP_GUIDANCE_CALL_CHARS).join('')}${CUT_MARK}`;
};

const callText = (call: LoopGuidanceCall): string => cut(canonicalJson({ name: call.name, arguments: call.arguments }));

const commandText = (command: string): string => `"${cut(JSON.stringify(command).slice(1, -1))}"`;

const bullets = (lines: readonly string[]): string[] => lines.map((line) => `- ${line}`);

export const loopGuidanceItem = (facts: LoopGuidanceFacts): InputItem => {
  const lines = [
    `Loop warning from the runtime: you have made the same tool call ${facts.count} times in a row with the same results. If you make it once more, the run stops.`,
    `Repeated call: ${callText(facts.repeated)}`,
    'Distinct calls made in the recent steps:',
    ...bullets(facts.distinctCalls.map(callText)),
    ...(facts.failedCommands.length === 0 ? [] : ['Commands that failed and have not succeeded since:', ...bullets(facts.failedCommands.map(commandText))]),
    'Change your approach instead of repeating this call.',
  ];
  return { type: 'message', role: 'user', content: lines.join('\n') };
};

type SeenCall = { name: string; arguments: unknown; callId: string };

type SeenGroup = { calls: SeenCall[]; answered: boolean };

const keptGroupsOf = (history: RunState['history']): SeenGroup[] => {
  const groups: SeenGroup[] = [];
  for (const { item } of history) {
    const open = groups.at(-1);
    if (item.type === 'function_call') {
      const parsed = parseBoundedJson(item.arguments);
      const call = { name: item.name, arguments: parsed.kind === 'value' ? parsed.value : parsed.text, callId: item.call_id };
      if (open !== undefined && !open.answered) open.calls.push(call);
      else groups.push({ calls: [call], answered: false });
    } else if (item.type === 'function_call_output' && open !== undefined) {
      open.answered = true;
    }
  }
  return groups.slice(-(LOOP_GROUPS_KEPT + 1));
};

const signatureOfCall = (call: LoopGuidanceCall): string => canonicalJson([call.name, call.arguments]);

const commandOf = (call: SeenCall): string => {
  const command = isRecord(call.arguments) ? call.arguments['command'] : undefined;
  return typeof command === 'string' ? command : canonicalJson(call.arguments);
};

export const loopGuidanceFactsOf = (input: {
  state: RunState;
  signature: string;
  resultOf: (providerCallId: string) => CallResult | undefined;
  isExecute: (toolName: string) => boolean;
}): LoopGuidanceFacts => {
  const { state, signature, resultOf, isExecute } = input;
  const groups = keptGroupsOf(state.history);
  const last = groups.at(-1);
  const first = last?.calls[0];
  if (first === undefined) throw new Error(`run ${state.runId} has no repeated call to write loop guidance about`);
  const closedRepeats = state.loopGroups.length - state.loopGroups.findLastIndex((group) => group.signature !== signature) - 1;
  const seen = groups.flatMap((group) => group.calls);
  const distinct = new Map<string, LoopGuidanceCall>();
  for (const call of seen) {
    const key = signatureOfCall(call);
    if (!distinct.has(key)) distinct.set(key, { name: call.name, arguments: call.arguments });
  }
  const failed = new Map<string, string>();
  seen.forEach((call, index) => {
    if (!isExecute(call.name) || resultOf(call.callId) !== 'failed') return;
    const key = signatureOfCall(call);
    const resolved = seen.slice(index + 1).some((later) => signatureOfCall(later) === key && resultOf(later.callId) === 'completed');
    if (!resolved && !failed.has(key)) failed.set(key, commandOf(call));
  });
  return {
    repeated: { name: first.name, arguments: first.arguments },
    count: closedRepeats + 1,
    distinctCalls: [...distinct.values()],
    failedCommands: [...failed.values()],
  };
};
