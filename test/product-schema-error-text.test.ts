import { describe, expect, it } from 'vitest';
import { checkRun, checkRunEvent, checkSession } from '../packages/cli/src/client/contract.ts';
import { assertMcpServer, assertMcpServersFile, assertSettings } from '../packages/config/src/settings.ts';
import { parseContextDataset } from '../packages/eval/src/context-dataset.ts';
import { parsePolicyOverlay } from '../packages/eval/src/context-policy.ts';
import { parseContextReport } from '../packages/eval/src/context-report.ts';
import { parseDataset } from '../packages/eval/src/dataset.ts';
import { parseOutcomeFile } from '../packages/eval/src/guideline-outcome.ts';
import { parseGuidelineAnalysis, parseGuidelineCandidate } from '../packages/eval/src/guideline-prompts.ts';
import { parsePublicRunEvent } from '../packages/eval/src/transcript.ts';
import { createRequestValidator, createStoredDataChecks } from '../packages/gateway/src/core/validation.ts';
import { validateBody } from '../packages/runtime/src/service/request.ts';
import { createOpenResponsesValidator } from '../packages/testkit/src/open-responses-schema.ts';

const FLATTENED_VARIANTS = /matched \d+ of \d+ (?:anyOf|oneOf) variants/;

const thrown = (action: () => unknown): Error & Record<string, unknown> => {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error as Error & Record<string, unknown>;
    throw new Error(`threw a non-error: ${String(error)}`);
  }
  throw new Error('expected a rejection, but the value was accepted');
};

const clauses = (text: string): number => text.match(/\bmust\b/g)?.length ?? 0;

const OLLAMA_TARGET = { adapter: 'ollama', model: 'devstral-small-2', baseUrl: 'http://127.0.0.1:50175/', capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } };
const UNKNOWN_EVENT = { id: 8, sessionId: 'sess-1', createdAt: 1800000000000, type: 'martian', mode: 'plan' };

describe('settings and MCP config errors keep a specific message', () => {
  it('names the enum that failed', () => {
    expect(thrown(() => assertSettings({ permissions: { defaultMode: 'bogus' } }, 'settings.json')).message).toBe(
      'settings.json: invalid settings at /permissions/defaultMode: must be equal to one of the allowed values',
    );
  });

  it('names the tag of a target whose adapter is unknown, not the count of variants', () => {
    const message = thrown(() => assertSettings({ models: { targets: { local: { ...OLLAMA_TARGET, adapter: 'nope' } } } }, 'settings.json')).message;
    expect(message).toMatch(/^settings\.json: invalid settings at \/models\/targets\/local/);
    expect(message).toContain('adapter');
    expect(message).not.toMatch(FLATTENED_VARIANTS);
  });

  it('names the property a tagged target is missing', () => {
    const { capabilities: _capabilities, ...withoutCapabilities } = OLLAMA_TARGET;
    const message = thrown(() => assertSettings({ models: { targets: { local: withoutCapabilities } } }, 'settings.json')).message;
    expect(message).toMatch(/^settings\.json: invalid settings at \/models\/targets\/local/);
    expect(message).toContain("must have required property 'capabilities'");
    expect(message).not.toMatch(FLATTENED_VARIANTS);
  });

  it('names the property an MCP server is missing and the field of an MCP file that has the wrong type', () => {
    expect(thrown(() => assertMcpServer({ type: 'stdio' }, 'mcp.json', 'srv')).message).toBe(`mcp.json: invalid MCP server "srv": /: must have required property 'command'`);
    expect(thrown(() => assertMcpServersFile({ mcpServers: 3 }, 'mcp.json')).message).toBe('mcp.json: invalid MCP server file at /mcpServers: must be object');
  });
});

describe('Run API 400 bodies keep a specific message', () => {
  it('names the missing property', () => {
    const error = thrown(() => validateBody('CreateRunRequest', { history: 'fresh' }));
    expect(error['status']).toBe(400);
    expect(error.message).toContain("must have required property 'input'");
  });

  it('names the property with the wrong type', () => {
    const error = thrown(() => validateBody('CreateRunRequest', { input: 'hi', timeoutMs: 'soon', extra: 1 }));
    expect(error['status']).toBe(400);
    expect(error.message).toMatch(/timeoutMs/);
    expect(error.message).toContain('must be integer');
  });

  it('names the nested map entry with the wrong type', () => {
    const error = thrown(() => validateBody('CreateSessionRequest', { cwd: '/w', env: { A: 1 } }));
    expect(error['status']).toBe(400);
    expect(error.message).toContain('env/A');
    expect(error.message).toContain('must be string');
  });
});

describe('the CLI contract and transcripts name what is wrong with an event', () => {
  it('names the field of a run view that left its enum', () => {
    const message = thrown(() =>
      checkRun(
        { id: 'run-1', sessionId: 'session-1', ordinal: 1, status: 'exploded', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, step: 1, limits: {}, createdAt: 1, deadlineAt: 2 },
        'GET /x',
      ),
    ).message;
    expect(message).toMatch(/^GET \/x answered a body that does not match the Run API contract: /);
    expect(message).toMatch(/status/);
  });

  it('names the missing property of a session view', () => {
    const message = thrown(() => checkSession({ cwd: '/work/a' }, 'GET /x')).message;
    expect(message).toContain("must have required property 'id'");
  });

  it('reports one specific message for an event of an unknown type, not every variant flattened', () => {
    const message = thrown(() => checkRunEvent(UNKNOWN_EVENT, 'GET /x')).message;
    const detail = message.replace(/^GET \/x answered a body that does not match the Run API contract: /, '');
    expect(detail).toMatch(/\btype\b/);
    expect(detail).not.toContain("required property 'runId'");
    expect(detail).not.toMatch(FLATTENED_VARIANTS);
    expect(clauses(detail)).toBe(1);
  });

  it('reports the type of an unknown transcript event, not a property of an arbitrary variant', () => {
    const message = thrown(() => parsePublicRunEvent(UNKNOWN_EVENT, 'run.jsonl:1')).message;
    expect(message).toMatch(/^run\.jsonl:1: not a public run event \(/);
    expect(message).toMatch(/\/type\b/);
    expect(message).not.toContain("required property 'runId'");
    expect(message).not.toMatch(FLATTENED_VARIANTS);
  });
});

describe('eval files keep a specific message', () => {
  it('names the field of a dataset that is wrong', () => {
    expect(thrown(() => parseDataset(JSON.stringify({ format: 'momonga-eval/1', name: 'golden', cases: 'x' }), 'cases.json')).message).toBe('cases.json: invalid dataset at /cases: must be array');
  });

  it('names the unknown key of a policy overlay', () => {
    expect(thrown(() => parsePolicyOverlay(JSON.stringify({ bogus: 1 }), 'policy.json')).message).toBe('policy.json: not a token policy overlay (/bogus: must NOT have additional properties)');
    expect(thrown(() => parsePolicyOverlay(JSON.stringify({ context: 5 }), 'policy.json')).message).toBe('policy.json: not a token policy overlay (/context: must be object)');
  });

  it('names the shape a context report must have', () => {
    expect(thrown(() => parseContextReport('[]', 'report.json')).message).toBe('report.json: not a context report (/: must be object)');
  });

  it('names the property a context dataset is missing', () => {
    expect(thrown(() => parseContextDataset(JSON.stringify({ format: 'momonga-eval-context/1', name: 'n' }), 'ctx.json')).message).toBe(
      "ctx.json: invalid dataset at /: must have required property 'cases'",
    );
  });

  it('names the property an outcome file is missing', () => {
    expect(thrown(() => parseOutcomeFile(JSON.stringify({ digest: 'x' }))).message).toBe("the outcome file is not a momonga-guideline-outcome/1 file: /: must have required property 'outcome'");
  });

  it('names what is wrong with a model reply to a guideline prompt', () => {
    expect(parseGuidelineCandidate(JSON.stringify({ guideline: '' }))).toEqual({ error: '/guideline: must NOT have fewer than 1 characters' });
    expect(parseGuidelineAnalysis('{}')).toEqual({ error: "/: must have required property 'divergence_step_description'" });
  });
});

describe('gateway 400 bodies report the inner message of an anyOf or oneOf', () => {
  const validator = createRequestValidator();

  it.each([
    [{ model: 3, input: 'hi' }, 'model must be string', 'model'],
    [{ model: 'm', input: 3 }, 'input must be string', 'input'],
    [{ model: 'm', input: 'hi', max_output_tokens: 3 }, 'max_output_tokens must be >= 16', 'max_output_tokens'],
    [{ model: 'm', input: 'hi', reasoning: { effort: 'galactic' } }, 'reasoning.effort must be equal to one of the allowed values', 'reasoning.effort'],
    [{ model: 'm', input: [{ type: 'function_call_output', call_id: 'c', output: 5 }] }, 'input[0].output must be string', 'input[0].output'],
    [{ model: 'm', input: [{ type: 'hologram', role: 'system', content: 'x' }] }, 'input[0].type has unknown item type "hologram"', 'input[0].type'],
  ])('rejects %j with %s', (body, message, param) => {
    const error = thrown(() => validator.parseCreate(body));
    expect(error['status']).toBe(400);
    expect(error.message).toBe(message);
    expect((error['body'] as { param: unknown }).param).toBe(param);
  });

  it('reports the inner message for a compact request', () => {
    expect(thrown(() => validator.parseCompact({ model: 'm', input: 3 })).message).toBe('input must be string');
  });
});

describe('gateway stored-data checks behind 500 bodies keep a specific message', () => {
  const checks = createStoredDataChecks();

  it('names the field of a stored output item, not the count of variants', () => {
    const problem = checks.outputItems([{ type: 'function_call_output', call_id: 'c', output: 5 }]);
    expect(problem).toMatch(/^output\[0\]/);
    expect(problem).not.toMatch(FLATTENED_VARIANTS);
  });

  it('names the property a compact resource is missing', () => {
    const problem = checks.compactResource({});
    expect(problem).toMatch(/must have required property '\w+'|required/);
    expect(problem).not.toMatch(FLATTENED_VARIANTS);
  });
});

describe('the Open Responses test validator reports one mapped error, not Ajv variant noise', () => {
  it('reports the inner message of an anyOf failure and nothing else', () => {
    const verdict = createOpenResponsesValidator().validate('CreateResponseBody', { model: 3, input: 'x' });
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.some((error) => /\/model\b.*must be string/.test(error))).toBe(true);
    expect(verdict.errors.filter((error) => /must match a schema in anyOf|must be null/.test(error))).toEqual([]);
    expect(verdict.errors.filter((error) => FLATTENED_VARIANTS.test(error))).toEqual([]);
  });
});
