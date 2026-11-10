import crypto from 'node:crypto';
import type { MomongaPaths } from '@momonga/foundation';
import { REPORT_PAGE_ROWS, REVIEW_LABELS } from '@momonga/protocol';
import type { PermissionReviewView, ReviewLabel, ReviewPage, RunCallView } from '@momonga/protocol';
import { describeRate } from '@momonga/reliability';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';

export type ReviewCall = RunCallView;

export type ReviewSample = { allowedWithoutPerson: ReviewCall[]; asks: ReviewCall[] };

const keyOf = (call: ReviewCall, seed: string): string => crypto.createHash('sha256').update(call.callId + seed).digest('hex');

const drawn = (calls: readonly ReviewCall[], options: { size: number; seed: string }): ReviewCall[] =>
  calls
    .map((call) => ({ call, key: keyOf(call, options.seed) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, options.size)
    .map(({ call }) => call);

const allowedWithoutPerson = (call: ReviewCall): boolean => !call.asked && call.basis !== null && call.basis !== 'person' && call.sideEffect !== 'read_only';

export const reviewSample = (calls: readonly ReviewCall[], options: { size: number; seed: string }): ReviewSample => ({
  allowedWithoutPerson: drawn(calls.filter(allowedWithoutPerson), options),
  asks: drawn(calls.filter((call) => call.asked), options),
});

export type ReviewPages = { reportReviews(request: { cursor: string | null; limit: number }): Promise<ReviewPage> };

export type ReviewWriter = { storeReview(request: { runId: string; callId: string; label: ReviewLabel }): Promise<PermissionReviewView> };

const keyOfCall = (call: { runId: string; callId: string }): string => JSON.stringify([call.runId, call.callId]);

const everyPage = async (client: ReviewPages): Promise<{ calls: ReviewCall[]; labels: Map<string, string> }> => {
  const calls: ReviewCall[] = [];
  const labels = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const page: ReviewPage = await client.reportReviews({ cursor, limit: REPORT_PAGE_ROWS });
    calls.push(...page.calls);
    for (const review of page.reviews) labels.set(keyOfCall(review), String(review.label));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { calls, labels };
};

const NOT_REVIEWED = 'not reviewed';

const callLine = (call: ReviewCall, labels: ReadonlyMap<string, string>): string =>
  `  ${call.runId} ${call.callId} basis ${call.basis === null ? 'none' : String(call.basis)}, side effect ${call.sideEffect === null ? 'not recorded' : String(call.sideEffect)}: ${labels.get(keyOfCall(call)) ?? NOT_REVIEWED}`;

const rateOf = (frame: readonly ReviewCall[], labels: ReadonlyMap<string, string>, label: ReviewLabel): { k: number; n: number } => {
  const reviewed = frame.flatMap((call) => {
    const stored = labels.get(keyOfCall(call));
    return stored === undefined ? [] : [stored];
  });
  return { k: reviewed.filter((stored) => stored === label).length, n: reviewed.length };
};

export const reviewSampleText = async (client: ReviewPages, options: { size: number; seed: string }): Promise<string> => {
  const { calls, labels } = await everyPage(client);
  const frame = reviewSample(calls, { size: calls.length, seed: options.seed });
  const sample = reviewSample(calls, options);
  return `${escapedLines([
    `Review sample of ${options.size} calls from each denominator, in the order of sha256(call id, seed) with the seed ${JSON.stringify(options.seed)}`,
    `Calls allowed without a person that have a side effect: ${sample.allowedWithoutPerson.length} drawn of ${frame.allowedWithoutPerson.length}`,
    ...sample.allowedWithoutPerson.map((call) => callLine(call, labels)),
    `Asks: ${sample.asks.length} drawn of ${frame.asks.length}`,
    ...sample.asks.map((call) => callLine(call, labels)),
    `missed_ask: ${describeRate(rateOf(frame.allowedWithoutPerson, labels, 'missed_ask'))} of the reviewed calls allowed without a person that have a side effect (frame ${frame.allowedWithoutPerson.length})`,
    `unneeded_ask: ${describeRate(rateOf(frame.asks, labels, 'unneeded_ask'))} of the reviewed asks (frame ${frame.asks.length})`,
    'These rates describe the reviewed calls, not every call of the record.',
  ])}\n`;
};

const labelOf = (text: string): ReviewLabel => {
  const label = REVIEW_LABELS.find((known) => known === text);
  if (label === undefined) throw new RangeError(`--label must be correct, unneeded_ask or missed_ask, received ${JSON.stringify(text)}`);
  return label;
};

export const storeReviewText = async (client: ReviewWriter, request: { runId: string; callId: string; label: string }): Promise<string> => {
  const stored = await client.storeReview({ runId: request.runId, callId: request.callId, label: labelOf(request.label) });
  return `${escapedLines([`Stored the label ${String(stored.label)} for call ${stored.callId} of run ${stored.runId}.`])}\n`;
};

export type ReviewOptions = { kind: 'sample'; size: number; seed: string } | { kind: 'label'; runId: string; callId: string; label: string };

export const reviewPermissions = async (ports: CliPorts, paths: MomongaPaths, options: ReviewOptions): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    ports.stdout.write(options.kind === 'sample' ? await reviewSampleText(client, options) : await storeReviewText(client, options));
    return 0;
  } finally {
    await client.close();
  }
};
