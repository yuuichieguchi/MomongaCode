import { canonicalJson, sha256Hex } from '@momonga/foundation';
import { PREFIX_EVENTS } from '@momonga/protocol';
import type { BuiltContext, ContextZones } from '@momonga/context';
import type { FunctionTool, InputItem, PrefixEvent, RunEvent, RunEventPayload } from '@momonga/protocol';
import type { ClaimContext } from './claim-context.ts';
import { isRecord } from './json.ts';
import { prefixRelationOf } from './prefix-relation.ts';

type Prefix = { preservedItems: number; toolsChanged: boolean; causes: PrefixEvent[] };

export type PrefixRecord = { prefix: Prefix; notices: RunEventPayload[] };

const BREAK_EVENT_TYPES = [
  'run.started',
  'context.compacted',
  'context.compaction_rejected',
  'context.truncated',
  'context.governing_loaded',
  'instructions.loaded',
  'skill.activated',
  'tool.loaded',
] as const satisfies readonly RunEventPayload['type'][];

const zonesOfRequests = new WeakMap<ClaimContext, ContextZones>();

const requestShapeOf = (body: unknown): { input: InputItem[]; tools: FunctionTool[] } => {
  if (!isRecord(body)) throw new Error('a recorded model request is not an object');
  const { input } = body;
  const tools = body['tools'] ?? [];
  if (!Array.isArray(tools)) throw new Error('a recorded model request carries tools that are not a list');
  if (typeof input === 'string') return { input: [{ type: 'message', role: 'user', content: input }], tools: tools as FunctionTool[] };
  if (!Array.isArray(input)) throw new Error('a recorded model request carries no input');
  return { input: input as InputItem[], tools: tools as FunctionTool[] };
};

const causesOf = (events: readonly RunEvent[], previousSeq: number, wrapUp: boolean): PrefixEvent[] => {
  const between = events.filter((event) => event.seq > previousSeq);
  const found = new Set<PrefixEvent>();
  for (const event of between) {
    switch (event.type) {
      case 'run.started':
        found.add('claim');
        break;
      case 'context.compacted':
        found.add('compaction');
        break;
      case 'context.compaction_rejected':
        found.add('compaction_rejected');
        break;
      case 'context.truncated':
        if (event.kind === 'omitted') found.add('eviction');
        break;
      case 'context.governing_loaded':
        found.add('governing_changed');
        break;
      case 'instructions.loaded':
        found.add(events.some((earlier) => earlier.type === 'instructions.loaded' && earlier.path === event.path && earlier.seq <= previousSeq) ? 'instructions_replaced' : 'instructions_arrived');
        break;
      case 'skill.activated':
        found.add('skill_activated');
        break;
      case 'tool.loaded':
        found.add('tools_loaded');
        break;
      default:
        break;
    }
  }
  if (wrapUp) found.add('wrap_up');
  return PREFIX_EVENTS.filter((name) => found.has(name));
};

const NOTHING_PRESERVED: readonly PrefixEvent[] = ['tools_loaded', 'wrap_up'];

type RecordedMarks = { zones: ContextZones; cacheKey: string };

const recordedMarksOf = (body: unknown): RecordedMarks | undefined => {
  if (!isRecord(body) || !isRecord(body['momonga']) || !isRecord(body['momonga']['cache'])) return undefined;
  const { stable, fixed, history } = body['momonga']['cache'];
  const cacheKey = body['prompt_cache_key'];
  if (typeof stable !== 'number' || typeof fixed !== 'number' || typeof history !== 'number' || typeof cacheKey !== 'string') return undefined;
  return { zones: { stableEnd: stable, arrivalsStart: stable, arrivalsEnd: stable, fixedEnd: fixed, historyEnd: history, arrivalKeys: [] }, cacheKey };
};

const claimKeepsPrefix = (marks: RecordedMarks | undefined, built: BuiltContext): boolean =>
  marks !== undefined && marks.cacheKey === sha256Hex(canonicalJson({ tools: built.tools, S: built.input.slice(0, built.zones.stableEnd) }));

const preservedBy = (cause: PrefixEvent, zones: ContextZones, previousInput: readonly InputItem[], between: readonly RunEvent[], claimKept: boolean): number => {
  switch (cause) {
    case 'eviction': {
      const evicted = new Set(between.flatMap((event) => (event.type === 'context.truncated' && event.kind === 'omitted' ? [event.callId] : [])));
      const at = previousInput.findIndex((item) => item.type === 'function_call_output' && evicted.has(item.call_id));
      return at < 0 ? zones.historyEnd : at;
    }
    case 'compaction':
    case 'compaction_rejected':
      return zones.fixedEnd;
    case 'governing_changed':
    case 'instructions_arrived':
    case 'skill_activated':
      return zones.arrivalsEnd;
    case 'instructions_replaced': {
      const replaced = between.flatMap((event) => (event.type === 'instructions.loaded' ? [`instructions:${event.path}`] : []));
      const positions = replaced.map((key) => zones.arrivalKeys.indexOf(key)).filter((position) => position >= 0);
      return zones.arrivalsStart + Math.min(zones.arrivalKeys.length, ...positions);
    }
    case 'claim':
      return claimKept ? zones.historyEnd : 0;
    case 'tools_loaded':
    case 'wrap_up':
      return 0;
  }
};

export const recordPrefix = (ctx: ClaimContext, built: BuiltContext, wrapUp: boolean): PrefixRecord | undefined => {
  const { store } = ctx.options;
  const previous = store.readLatestRunEventBefore(ctx.run.id, 'model.requested', ctx.journal.state.lastSeq + 1);
  const claimZones = zonesOfRequests.get(ctx);
  zonesOfRequests.set(ctx, built.zones);
  if (previous === undefined) return undefined;
  const before = requestShapeOf(previous.body);
  const relation = prefixRelationOf(before, { input: built.input, tools: built.tools });
  const between = store.readRunEventsOfTypes(ctx.run.id, [...BREAK_EVENT_TYPES], previous.seq);
  const causes = causesOf(between, previous.seq, wrapUp);
  const prefix: Prefix = { ...relation, causes };
  if (!ctx.token.cachePrefix) return { prefix, notices: [] };
  const toolsChangingCause = causes.some((cause) => NOTHING_PRESERVED.includes(cause));
  if (toolsChangingCause) return { prefix, notices: [] };
  const marks = recordedMarksOf(previous.body);
  const zones = claimZones ?? marks?.zones;
  const claimKept = claimKeepsPrefix(marks, built);
  if (zones === undefined && !causes.includes('claim')) throw new Error(`run ${ctx.run.id} built a request without a claim event after its previous request, and no zones of that request are known`);
  const allowed =
    zones === undefined
      ? 0
      : causes.length === 0
        ? zones.historyEnd
        : Math.min(...causes.map((cause) => preservedBy(cause, zones, before.input, between, claimKept)));
  if (relation.preservedItems >= allowed) return { prefix, notices: [] };
  return {
    prefix,
    notices: [
      {
        type: 'notice',
        level: 'info',
        code: 'prefix_unexplained',
        message: `The request keeps ${relation.preservedItems} leading items of the previous one, fewer than the ${allowed} that the named events (${causes.length === 0 ? 'none' : causes.join(', ')}) allow`,
      },
    ],
  };
};
