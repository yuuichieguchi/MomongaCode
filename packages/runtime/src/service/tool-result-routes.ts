import { TOOL_RESULT_PAGE_BYTES } from '@momonga/protocol';
import type { RunEvent, ToolResultPage } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { notFound } from './errors.ts';
import type { RouteRegistrar } from './app.ts';
import { integerQueryOf } from './request.ts';

const ENDING_TYPES = ['tool.completed', 'tool.reconciled', 'tool.held.resolved'] as const;

type EndedCall = Extract<RunEvent, { type: (typeof ENDING_TYPES)[number] }>;

const json = (body: ToolResultPage): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

const inlinePage = (output: string, offset: number): ToolResultPage => {
  const bytes = Buffer.from(output, 'utf8');
  let start = Math.min(offset, bytes.length);
  while (isContinuation(bytes[start])) start += 1;
  let end = Math.min(bytes.length, start + TOOL_RESULT_PAGE_BYTES);
  while (end < bytes.length && isContinuation(bytes[end])) end -= 1;
  return { text: bytes.subarray(start, end).toString('utf8'), offset: start, next: end < bytes.length ? end : null, totalBytes: bytes.length };
};

export const registerToolResultRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'getRun' | 'readRunEventsOfTypes' | 'blobs'> }): void => {
  const { store } = deps;
  route('/v1/runs/:id/tool-results/:callId', {
    GET: async (context) => {
      const runId = context.req.param('id') ?? '';
      const callId = context.req.param('callId') ?? '';
      if (store.getRun(runId) === undefined) throw notFound(`run ${runId} does not exist`);
      const offset = integerQueryOf(new URL(context.req.url).searchParams.get('offset') ?? undefined, 'offset', { from: 0, to: Number.MAX_SAFE_INTEGER }) ?? 0;
      const ended = store.readRunEventsOfTypes(runId, ENDING_TYPES, 0).filter((event): event is EndedCall => 'callId' in event && event.callId === callId).at(-1);
      if (ended === undefined) throw notFound(`the call ${callId} of run ${runId} has no stored result`);
      const handle = 'handle' in ended ? ended.handle : undefined;
      if (handle === undefined) return json(inlinePage(ended.output, offset));
      const slice = await store.blobs.read(handle, { offset, length: TOOL_RESULT_PAGE_BYTES }, { runId });
      const end = slice.offset + slice.length;
      return json({ text: slice.text, offset: slice.offset, next: end < slice.totalBytes ? end : null, totalBytes: slice.totalBytes });
    },
  });
};
