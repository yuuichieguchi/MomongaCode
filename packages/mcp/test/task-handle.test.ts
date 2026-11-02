import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { TASK_HANDLE_ERROR_CODE, createTaskHandleRewriter, taskHandleOf } from '../src/task-handle.ts';

const toolsCall = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x' } });
const taskResult = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: { resultType: 'task', taskId: 't-1', status: 'working' } });

describe('task handle rewriting', () => {
  it('turns the task result of a tracked tools/call into the handle error', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound(toolsCall(7));
    const rewritten = rewriter.inbound(taskResult(7));
    expect(rewritten).toMatchObject({ id: 7, error: { code: TASK_HANDLE_ERROR_CODE, data: { resultType: 'task', taskId: 't-1' } } });
  });

  it('does not untrack a call when the server sends its own request with the same id', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound(toolsCall(7));
    const serverRequest: JSONRPCMessage = { jsonrpc: '2.0', id: 7, method: 'elicitation/create', params: {} };
    expect(rewriter.inbound(serverRequest)).toBe(serverRequest);
    expect(rewriter.inbound(taskResult(7))).toMatchObject({ error: { code: TASK_HANDLE_ERROR_CODE } });
  });

  it('untracks a call when its response is an error, so a later reuse of the id is not rewritten', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound(toolsCall(7));
    rewriter.inbound({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'boom' } });
    const stray = taskResult(7);
    expect(rewriter.inbound(stray)).toBe(stray);
  });

  it('untracks a call the client cancelled', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound(toolsCall(7));
    rewriter.outbound({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    const late = taskResult(7);
    expect(rewriter.inbound(late)).toBe(late);
  });

  it('forgets every tracked call on reset', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound(toolsCall(7));
    rewriter.reset();
    const late = taskResult(7);
    expect(rewriter.inbound(late)).toBe(late);
  });

  it('leaves the results of other methods alone', () => {
    const rewriter = createTaskHandleRewriter();
    rewriter.outbound({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const listing = taskResult(3);
    expect(rewriter.inbound(listing)).toBe(listing);
  });
});

describe('taskHandleOf', () => {
  it('accepts the sentinel code with a task-shaped payload', () => {
    expect(taskHandleOf(TASK_HANDLE_ERROR_CODE, { resultType: 'task', taskId: 't' })).toEqual({ resultType: 'task', taskId: 't' });
  });

  it('refuses a server error that merely uses the sentinel code', () => {
    expect(taskHandleOf(TASK_HANDLE_ERROR_CODE, { detail: 'plain server error' })).toBeUndefined();
    expect(taskHandleOf(TASK_HANDLE_ERROR_CODE, undefined)).toBeUndefined();
    expect(taskHandleOf(-32603, { resultType: 'task' })).toBeUndefined();
  });
});
