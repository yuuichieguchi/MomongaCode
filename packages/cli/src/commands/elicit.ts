import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { ElicitationAnswerRecord } from '@momonga/protocol';
import { cleanFailureMessage, parseOutsideJson } from '@momonga/foundation';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { describeElicitation } from '../elicit/describe.ts';
import { fieldsOf, parseFieldInput, validateContent } from '../elicit/form.ts';
import type { ContentValue } from '../elicit/form.ts';
import type { ElicitationView } from '../client/views.ts';
import { couldNotOpenBrowser } from '../browser-text.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { UsageError } from '../usage-error.ts';
import { activeRunIdOf, runTreeOf } from './targets.ts';
import type { RuntimeClient } from '../client/runtime-client.ts';

export class ElicitationUsageError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = 'ElicitationUsageError';
  }
}

export type ElicitOptions = { accept: boolean; decline: boolean; cancel: boolean; set: readonly string[]; responses?: string };

const titleOf = (view: ElicitationView): string => view.toolCall.title;

const elicitationText = (view: ElicitationView): string =>
  describeElicitation(view.id, view.server, titleOf(view), view.requests).map(escapeTerminalLine).join('\n');

const chosenActions = (options: ElicitOptions): string[] =>
  [options.accept ? '--accept' : undefined, options.decline ? '--decline' : undefined, options.cancel ? '--cancel' : undefined, options.responses === undefined ? undefined : '--responses'].filter(
    (flag): flag is string => flag !== undefined,
  );

const parseSettings = (settings: readonly string[]): Map<string, string> => {
  const values = new Map<string, string>();
  for (const setting of settings) {
    const separator = setting.indexOf('=');
    if (separator <= 0) throw new ElicitationUsageError(`--set expects name=value, got ${JSON.stringify(setting)}`);
    values.set(setting.slice(0, separator), setting.slice(separator + 1));
  }
  return values;
};

type Accepted = { answer: ElicitationAnswerRecord; notice?: string };

const declinedForValidator = (view: ElicitationView, key: string, message: string): Accepted => ({
  answer: { action: 'decline' },
  notice: `Elicitation ${JSON.stringify(cleanFailureMessage(key))} of MCP server ${JSON.stringify(cleanFailureMessage(view.server))} was declined: its requestedSchema validator failed: ${message}`,
});

const acceptedContent = async (view: ElicitationView, settings: readonly string[], signal: AbortSignal): Promise<Accepted> => {
  const [request] = view.requests;
  if (view.requests.length !== 1 || request === undefined) {
    throw new ElicitationUsageError(`elicitation ${view.id} has ${view.requests.length} requests; answer them together with --responses`);
  }
  if (request.mode === 'url') {
    if (settings.length > 0) throw new ElicitationUsageError('a url request takes no --set values');
    return { answer: { action: 'accept' } };
  }
  const fields = fieldsOf(request.requestedSchema);
  const values = parseSettings(settings);
  const unknown = [...values.keys()].filter((name) => !fields.some((field) => field.name === name));
  if (unknown.length > 0) throw new ElicitationUsageError(`unknown field ${unknown.join(', ')}; the request asks for ${fields.map((field) => field.name).join(', ')}`);
  const content: Record<string, ContentValue> = {};
  for (const field of fields) {
    const text = values.get(field.name);
    if (text === undefined) continue;
    const origin = { server: view.server, key: request.key };
    const parsed = await parseFieldInput(origin, field, text, signal);
    if (!parsed.ok) {
      if (parsed.reason === 'validator-failed') return declinedForValidator(view, request.key, parsed.error);
      throw new ElicitationUsageError(parsed.error);
    }
    if (parsed.value !== undefined) content[field.name] = parsed.value;
  }
  const check = await validateContent({ server: view.server, key: request.key }, request.requestedSchema, content, signal);
  if (check.kind === 'validator-failed') return declinedForValidator(view, request.key, check.message);
  if (check.kind === 'invalid') throw new ElicitationUsageError(`the answer does not match the request: ${check.message}`);
  return { answer: { action: 'accept', content } };
};

const parseResponses = (text: string): Record<string, ElicitationAnswerRecord> => {
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(text);
  } catch (error) {
    throw new ElicitationUsageError(`--responses must be JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ElicitationUsageError('--responses must be a JSON object keyed by request key');
  return parsed as Record<string, ElicitationAnswerRecord>;
};

type Responses = { responses: Record<string, ElicitationAnswerRecord>; notices: string[] };

const responsesFor = async (view: ElicitationView, options: ElicitOptions, signal: AbortSignal): Promise<Responses> => {
  if (options.responses !== undefined) return { responses: parseResponses(options.responses), notices: [] };
  if (options.decline || options.cancel) {
    const action = options.decline ? 'decline' : 'cancel';
    return { responses: Object.fromEntries(view.requests.map((request) => [request.key, { action }])), notices: [] };
  }
  const [request] = view.requests;
  const accepted = await acceptedContent(view, options.set, signal);
  return { responses: Object.fromEntries([[request?.key ?? '', accepted.answer]]), notices: accepted.notice === undefined ? [] : [accepted.notice] };
};

export const pendingElicitationsOf = async (client: Pick<RuntimeClient, 'getRun' | 'childRuns' | 'elicitations'>, runId: string): Promise<ElicitationView[]> => {
  const tree = await runTreeOf(client, runId);
  const views = await Promise.all(tree.map(async ({ run }) => client.elicitations(run.id)));
  return views.flat().filter((view) => view.status === 'pending');
};

export const elicit = async (ports: CliPorts, paths: MomongaPaths, inputId: string | undefined, options: ElicitOptions, interrupt: AbortSignal): Promise<number> => {
  const actions = chosenActions(options);
  if (actions.length > 1) throw new ElicitationUsageError(`choose one of --accept, --decline, --cancel and --responses, not ${actions.join(' and ')}`);
  if (inputId === undefined && (actions.length > 0 || options.set.length > 0)) throw new ElicitationUsageError('name the elicitation to answer: momonga elicit <id> ...');
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    if (inputId === undefined) {
      const runId = await activeRunIdOf(client, ports.cwd);
      const pending = await pendingElicitationsOf(client, runId);
      ports.stdout.write(
        pending.length === 0 ? `run ${runId} has no pending elicitations\n` : `${pending.map(elicitationText).join('\n')}\n`,
      );
      return 0;
    }
    const view = await client.getElicitation(inputId);
    if (actions.length === 0) {
      if (options.set.length > 0) throw new ElicitationUsageError('--set needs --accept');
      ports.stdout.write(`${elicitationText(view)}\n`);
      return 0;
    }
    if (options.set.length > 0 && !options.accept) throw new ElicitationUsageError('--set needs --accept');
    const { responses, notices } = await responsesFor(view, options, interrupt);
    for (const notice of notices) ports.stderr.write(`${escapeTerminalLine(`momonga: ${notice}`)}\n`);
    const [request] = view.requests;
    if (options.accept && request?.mode === 'url') {
      const url = new URL(request.url);
      ports.stderr.write(`${escapeTerminalLine(`Open this URL in your browser: ${url.href}`)}\n`);
      ports.openUrl(url, interrupt, (message) => ports.stderr.write(`${escapeTerminalLine(couldNotOpenBrowser(message))}\n`));
    }
    const resolved = await client.resolveElicitation(view.id, responses);
    ports.stdout.write(`elicitation ${resolved.elicitation.id} ${resolved.elicitation.status}; run ${resolved.run.id} is ${resolved.run.status}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
