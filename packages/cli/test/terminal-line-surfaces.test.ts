import { describe, expect, it } from 'vitest';
import type { Capabilities, McpServerView, MomongaModelEntry, RunTraceSpan, RunTraceView, SupervisorHealth, UsageReport } from '@momonga/protocol';
import { waitFor } from '@momonga/testkit';
import { describeFailure } from '../src/failure.ts';
import { formatMcpServers, mcpAuthorizationInvitation } from '../src/commands/mcp.ts';
import { formatModels } from '../src/commands/models.ts';
import { daemonStatusText } from '../src/commands/daemon.ts';
import { renderTrace } from '../src/commands/trace.ts';
import { announceUpdate, startBackgroundCheck } from '../src/update/background.ts';
import { setupUpdate } from './update-harness.ts';

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

  it('shows a model alias and its targets with a newline on the alias line', () => {
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
    const entry: MomongaModelEntry = { id: `fast ${FORGED}`, object: 'model', targets: [`t ${FORGED}`], capabilities, targetCapabilities: {} };
    const lines = formatModels([entry]).split('\n');
    expect(lines[0]).toBe(`fast ${SHOWN}  -> t ${SHOWN}`);
    expect(lines).toHaveLength(6);
  });

  it('shows a daemon child held reason with a newline on the child line', () => {
    const health = {
      status: 'ok',
      version: '1',
      apiVersion: 1,
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
      summary: { steps: 1, chatCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, errorCount: 0, durationMs: 1, chatResults: [] },
      spans: [span({ name: `root ${FORGED}` }), span({ spanId: 'c', parentSpanId: 's', name: 'chat', attributes: { 'momonga.target': 't', 'momonga.failure_message': FORGED } })],
    };
    const usage = { total: { input_tokens: 1, output_tokens: 1 }, responses: [] } as unknown as UsageReport;
    const lines = renderTrace(view, usage).split('\n');
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
});
