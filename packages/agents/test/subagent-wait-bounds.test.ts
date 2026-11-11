import { describe, expect, it } from 'vitest';
import { childResultOf } from '@momonga/agents';

const MODEL_IDLE_TEXT = 'The model sent no output for 300 s (only keep-alive signals arrived), so the call was stopped. Raise models.idleTimeoutMs if this model needs longer.';
const MCP_IDLE_TEXT =
  'MCP server "jobs" sent no response or progress for 5 minutes, so the call to long_job was stopped. The server may have run it; check before repeating it. To wait longer, raise mcp.toolIdleTimeoutNetworkMs.';

const finished = (status: 'FAILED' | 'COMPLETED', fields: { error?: { code: string; message: string }; text: string }) => ({
  state: 'finished' as const,
  runId: 'child-1',
  sessionId: 'session-1',
  status,
  ...fields,
});

describe('G3: the subagent wait has no timer of its own; its bound is the bound of each child step (R-G3)', () => {
  it('test 1: returns a child ended by the model idle bound to the parent as a failure carrying the G1 text', () => {
    expect(childResultOf('explorer', finished('FAILED', { error: { code: 'stream_interrupted', message: `the upstream stream was interrupted: ${MODEL_IDLE_TEXT}` }, text: '' }))).toEqual({
      status: 'failed',
      output: `Subagent explorer failed (stream_interrupted: the upstream stream was interrupted: ${MODEL_IDLE_TEXT}).`,
    });
  });

  it('test 2: returns the final message of a child whose MCP call ended by the G2 idle window, so the parent sees the G2 text', () => {
    expect(childResultOf('explorer', finished('COMPLETED', { text: `The tool failed: ${MCP_IDLE_TEXT}` }))).toEqual({ status: 'completed', output: `The tool failed: ${MCP_IDLE_TEXT}` });
  });
});
