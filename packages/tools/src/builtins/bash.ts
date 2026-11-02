import { randomBytes } from 'node:crypto';
import { findHolders, reconcileProcessGroup } from '@momonga/foundation';
import { defineTool, ToolExecutionError } from '../types.ts';
import type { SandboxExit } from '@momonga/sandbox';
import type { ToolContext } from '../types.ts';
import { createCapture, pumpOutput } from '../capture.ts';
import { canonicalDirectories, insideAny } from './paths.ts';

type BashInput = { command: string; timeout?: number; description?: string };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const TITLE_CHARS = 80;
const trapScript = (nonce: string): string =>
  `trap 'status=$?; printf "\\n__MOMONGA_CWD_${nonce}__=%s\\n" "$(pwd -P)"; exit $status' EXIT`;

const extractCwd = (output: string, nonce: string): { output: string; cwd: string | undefined } => {
  const prefix = `__MOMONGA_CWD_${nonce}__=`;
  const index = output.lastIndexOf(prefix);
  if (index === -1) return { output, cwd: undefined };
  const lineEnd = output.indexOf('\n', index);
  const cwd = output.slice(index + prefix.length, lineEnd === -1 ? output.length : lineEnd);
  const removeFrom = output[index - 1] === '\n' ? index - 1 : index;
  const removeTo = lineEnd === -1 ? output.length : lineEnd + 1;
  return { output: output.slice(0, removeFrom) + output.slice(removeTo), cwd };
};

const requireMarker = (ctx: ToolContext): string => {
  if (ctx.processMarker === undefined) throw new ToolExecutionError('Bash needs a process marker from the executor');
  return ctx.processMarker;
};

export const bashTool = defineTool<BashInput>({
  name: 'Bash',
  description:
    'Runs a shell command with /bin/bash inside a sandbox, in the current working directory. Output combines stdout and stderr. A cd that stays inside the workspace persists to later calls. timeout is in milliseconds (default 120000, maximum 600000). No process started by the command outlives it.',
  kind: 'execute',
  sideEffect: 'exec',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'The command to run' },
      timeout: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'Timeout in milliseconds' },
      description: { type: 'string', description: 'Short description of what the command does' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  timeoutMs: (input) => Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  title: (input) => input.description ?? input.command.slice(0, TITLE_CHARS),
  subject: (input) => ({ kind: 'command', tool: 'Bash', command: input.command }),
  execute: async (input, ctx) => {
    const marker = requireMarker(ctx);
    const nonce = randomBytes(16).toString('hex');
    const script = `${trapScript(nonce)}\n${input.command}`;
    const child = ctx.sandbox.spawn(
      {
        argv: ['/bin/bash', '-c', script],
        cwd: ctx.session.cwd,
        env: { ...ctx.env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat', GIT_PAGER: 'cat' },
        markerFile: marker,
        ...(ctx.tmpDir === undefined ? {} : { tmpDir: ctx.tmpDir }),
      },
      ctx.sandboxPolicy,
      ctx.signal,
    );
    ctx.attachProcess({ pgid: child.pgid, startedAt: ctx.clock.now() });

    const capture = createCapture();
    const pump = pumpOutput([child.stdout, child.stderr], (_index, chunk) => capture.push(chunk));
    let exit: SandboxExit;
    const notes: string[] = [];
    try {
      exit = await child.exited;
      const holders = await findHolders(marker);
      if (holders.length > 0) {
        await reconcileProcessGroup({ pgid: child.pgid, marker });
        notes.push(`Terminated ${holders.length} process(es) that outlived the command.`);
      }
      await pump.settle();
    } finally {
      await pump.close();
    }
    const failure = pump.failure();
    if (failure !== undefined) throw failure.error;

    const extracted = extractCwd(capture.text(), nonce);
    let output = extracted.output.replace(/\n+$/, '');
    if (extracted.cwd !== undefined) {
      if (insideAny(extracted.cwd, canonicalDirectories(ctx.roots))) {
        ctx.session.cwd = extracted.cwd;
      } else {
        output += `${output === '' ? '' : '\n'}Shell cwd was reset to ${ctx.session.cwd}`;
      }
    }
    for (const note of notes) output += `${output === '' ? '' : '\n'}${note}`;
    if (exit.signal !== null) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[terminated by ${exit.signal}]` };
    if (exit.code !== 0) return { status: 'failed', output: `${output}${output === '' ? '' : '\n'}[exit code ${exit.code}]` };
    return { status: 'completed', output };
  },
  reconcile: async (_input, record, ctx) => {
    if (record.pgid !== undefined && ctx.processMarker !== undefined) {
      return reconcileProcessGroup({ pgid: record.pgid, marker: ctx.processMarker });
    }
    return {
      outcome: 'unknown',
      output: 'The interrupted command may or may not have started, and its effect is unknown; inspect the current state before retrying it.',
    };
  },
});
