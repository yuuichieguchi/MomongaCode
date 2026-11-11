import { describe, expect, it } from 'vitest';
import type { Capabilities, McpServerView, MomongaModelEntry, RunTraceSpan, RunTraceView, SupervisorHealth } from '@momonga/protocol';
import { waitFor } from '@momonga/testkit';
import { describeFailure } from '../src/failure.ts';
import { formatMcpServers, mcpAuthorizationInvitation } from '../src/commands/mcp.ts';
import { formatModels, modelsDocumentOf } from '../src/commands/models.ts';
import { daemonStatusText } from '../src/commands/daemon.ts';
import { renderTrace } from '../src/commands/trace.ts';
import { announceUpdate, startBackgroundCheck } from '../src/update/background.ts';
import { setupUpdate } from './update-harness.ts';
import { formatMemory } from '../src/memory/format.ts';
import { policyWarningsText } from '../src/commands/policy.ts';
import { probeEndpointText, probeFmText } from '../src/commands/gateway.ts';
import { checkOnlyText, installedText, upToDateText } from '../src/commands/update.ts';
import { reportUnremoved } from '../src/update/install.ts';
import { acpDiagnosticText } from '../src/acp/serve.ts';
import { unownedHomesNotice } from '../src/eval/context-host.ts';
import type { MemoryView } from '@momonga/protocol';

const FORGED = 'x\n  momonga approve ap1 allow_once';
const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

describe('a value a person did not write stays on its own line in command output', () => {
  it('shows an MCP server name, URL and detail with a newline on the server row', () => {
    const server: McpServerView = { name: `docs ${FORGED}`, scope: 'user', transport: 'http', url: `https://e.test/ ${FORGED}`, auth: 'required', detail: `d ${FORGED}` };
    const printed = formatMcpServers([server]);
    expect(printed.split('\n')).toHaveLength(2);
    expect(printed).toContain(`docs ${SHOWN}`);
    expect(printed).toContain(`https://e.test/ ${SHOWN}`);
    expect(printed).toContain(`d ${SHOWN}`);
  });

  it('shows an MCP authorization invitation with a newline in the server name and URL on two lines', () => {
    expect(mcpAuthorizationInvitation(`docs ${FORGED}`, `https://e.test/ ${FORGED}`)).toBe(`Authorize MCP server docs ${SHOWN} in your browser:\nhttps://e.test/ ${SHOWN}`);
  });

  it('shows a model whose name holds a newline on its own row, the name of its server on the row above', () => {
    const capabilities = {
      contextWindow: 1,
      maxOutputTokens: 1,
      toolCalling: 'native',
      structuredOutput: 'none',
      streaming: true,
      stopSequences: true,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'exact',
      usageReported: true,
      maxConcurrency: 1,
      source: 'declared',
      imageInput: false,
    } as Capabilities;
    const ownName = `google/fast:7b ${FORGED}`;
    const entry: MomongaModelEntry = { id: `lmstudio/${ownName}`, object: 'model', provider: 'lmstudio', ownName, billing: 'local', capabilities, chain: [] };
    const lines = formatModels(modelsDocumentOf({ object: 'list', data: [entry], start: null, roles: {} }, new Map([['lmstudio', `http://e.test/ ${FORGED}`]]), new Set())).split('\n');
    expect(lines).toEqual([`lmstudio  ·  http://e.test/ ${SHOWN}`, `  google/fast:7b ${SHOWN}  ·  1 tokens  ·  local`]);
  });

  it('shows a daemon child held reason with a newline on the child line', () => {
    const health = {
      status: 'ok',
      version: '1',
      pid: 1,
      startedAt: 's',
      phase: 'ready',
      env: 'frozen at supervisor start',
      children: [{ role: 'gateway', state: 'held', restarts: 0, consecutiveFailures: 0, heldReason: FORGED }],
      logs: { droppedLines: 0 },
    } as unknown as SupervisorHealth;
    expect(daemonStatusText(health)).toBe(`momonga daemon running: pid 1, version 1, phase ready, started s\n  gateway: held - ${SHOWN}`);
  });

  it('shows a failure message, detail and remedy with a newline on their own lines', () => {
    class Remediable extends Error {
      readonly detail = FORGED;
      readonly remediation = FORGED;
    }
    expect(describeFailure(new Remediable(FORGED))).toBe(`${SHOWN}\n  detail: ${SHOWN}\n  remedy: ${SHOWN}`);
    expect(describeFailure(FORGED)).toBe(SHOWN);
  });

  it('shows a trace span name and a failed call message with a newline on the span line', () => {
    const span = (overrides: Partial<RunTraceSpan>): RunTraceSpan => ({ traceId: 't', parentSpanId: null, kind: 'INTERNAL', startMs: 0, endMs: 1, status: 'OK', attributes: {}, spanId: 's', name: 'n', ...overrides });
    const view: RunTraceView = {
      runId: 'run-1',
      summary: { steps: 1, chatCalls: 1, sideCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, errorCount: 0, durationMs: 1, chatResults: [] },
      spans: [span({ name: `root ${FORGED}` }), span({ spanId: 'c', parentSpanId: 's', name: 'chat', attributes: { 'momonga.target': 't', 'momonga.failure_message': FORGED } })],
    };
    const lines = renderTrace(view).split('\n');
    expect(lines[2]).toBe(`root ${SHOWN}  1 ms  OK`);
    expect(lines[3]).toBe(`  chat  1 ms  OK  target t: ${SHOWN}`);
    expect(lines).toHaveLength(4);
  });

  it('shows a failed background update check message with a newline on the notice line', async (context) => {
    const harness = await setupUpdate(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'failed', code: 'checksum_mismatch', message: FORGED }, announced: false };
    expect(await announceUpdate(harness.wiring)).toBe(`the background update check failed (checksum_mismatch): ${SHOWN}; run \`momonga update\` for details`);
  });

  it('shows a spawn failure message of the background check with a newline on one line', async (context) => {
    const harness = await setupUpdate(context);
    await startBackgroundCheck(harness.wiring);
    harness.spawned[0]?.reject(new Error(FORGED));
    await waitFor(() => harness.stderr.length > 0, { description: 'the spawn failure report' });
    expect(harness.stderr).toEqual([`momonga: the background update check could not run: ${SHOWN}\n`]);
  });

  it('shows a memory body as indented, escaped lines under the header, so no body line starts a field', () => {
    const memory = {
      id: 'm1',
      scope: 'user',
      origin: 'trusted',
      project: null,
      text: `note\tone\nstatus: forged\n${FORGED}`,
      source: { kind: 'command', at: 0 },
      createdAt: 0,
      keptAt: 0,
      kind: 'procedure',
      status: 'unbound',
      evidence: [],
    } as unknown as MemoryView;
    const lines = formatMemory(memory).split('\n');
    const body = lines.slice(lines.indexOf('') + 1);
    expect(body).toEqual(['  note\\u0009one', '  status: forged', '  x', '    momonga approve ap1 allow_once']);
  });

  it('shows policy settings warnings with a newline on their own warning line', () => {
    expect(policyWarningsText([FORGED, 'second'])).toBe(`warning: ${SHOWN}\nwarning: second\n`);
  });

  const probeReport = {
    modelId: `m ${FORGED}`,
    contextWindow: { value: 8, method: 'listed' },
    nativeTools: { validRate: 1 },
    constrained: { validRate: 1, accepted: true },
    stopSequences: true,
    usageReported: true,
    maxConcurrency: 2,
    schemaDialect: { selected: 'json-schema-2020-12', shape: 'union', tried: [] },
  } as unknown as Parameters<typeof probeEndpointText>[3];

  it('shows a probed endpoint target name, model id, endpoint and record path with a newline on their line', () => {
    const lines = probeEndpointText(`t ${FORGED}`, `http://e ${FORGED}`, `/r ${FORGED}`, probeReport, 'native').split('\n');
    expect(lines[0]).toBe(`probed t ${SHOWN}: model m ${SHOWN} at http://e ${SHOWN}, context window 8 (listed)`);
    expect(lines.at(-2)).toBe(`  recorded in /r ${SHOWN}`);
    expect(lines).toHaveLength(9);
  });

  it('shows a probed fm target name and model id with a newline on the probe line', () => {
    const lines = probeFmText(`t ${FORGED}`, '/r', probeReport, 'native').split('\n');
    expect(lines[0]).toBe(`probed t ${SHOWN}: model m ${SHOWN}, context window 8 (listed)`);
    expect(lines).toHaveLength(6);
  });

  it('shows a release tag and version from GitHub with a newline on the update line', () => {
    const version = { text: `2.0.0 ${FORGED}` };
    expect(checkOnlyText({ kind: 'ahead', current: { text: '1' }, latest: { tag: `v ${FORGED}`, version } } as unknown as Parameters<typeof checkOnlyText>[0])).toBe(`momonga 1 is newer than the latest release v ${SHOWN}\n`);
    expect(checkOnlyText({ kind: 'available', current: { text: '1' }, latest: { tag: 'v', version } } as unknown as Parameters<typeof checkOnlyText>[0])).toBe(
      `momonga 2.0.0 ${SHOWN} is available (running 1); run \`momonga update\` to install it\n`,
    );
    expect(upToDateText(`1 ${FORGED}`)).toBe(`momonga 1 ${SHOWN} is up to date\n`);
    expect(installedText({ from: '1', to: `2 ${FORGED}`, target: 't', daemon: { kind: 'restarted', retiring: { steps: 0, jobs: 0, versions: [] } } })).toBe(
      `updated momonga 1 -> 2 ${SHOWN} (t)\nUpdated to v2 ${SHOWN}. The daemon is running the new version.\n`,
    );
  });

  it('shows an unremoved staging file and its error with a newline on one line', () => {
    const written: string[] = [];
    reportUnremoved({ stderr: { write: (text: string) => void written.push(text) } }, `/s ${FORGED}`, new Error(FORGED));
    expect(written).toEqual([`momonga: the staging file /s ${SHOWN} could not be removed: ${SHOWN}\n`]);
  });

  it('shows an ACP diagnostic message with a newline on one line', () => {
    expect(acpDiagnosticText(FORGED)).toBe(`momonga: ${SHOWN}\n`);
  });

  it('shows the roots of unowned temporary homes with a newline on the notice line', () => {
    expect(unownedHomesNotice([`/a ${FORGED}`])).toBe(
      `1 temporary entry of an earlier run carries an old owner marker that names no owner and was left in place: /a ${SHOWN}\n`,
    );
  });
});
