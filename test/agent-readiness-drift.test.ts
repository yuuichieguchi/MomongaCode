import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

const CONSUMER_ROOTS = ['packages/runtime/src', 'packages/cli/src', 'packages/gateway/src/core', 'packages/gateway/src/adapters'];

const WIRE_BACKSTOPS = ['packages/gateway/src/adapters/chat-completions/adapter.ts', 'packages/gateway/src/adapters/open-responses/adapter.ts'];

const READINESS_BRANCHES = [/toolCalling\s*[!=]==\s*'(none|native|constrained)'/, /typeof\s+[\w.[\]'"]*toolCalling['"\]]*\s*[!=]==\s*'string'/];

const sourcesUnder = (dir: string): string[] =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });

const branchingFiles = (): string[] =>
  CONSUMER_ROOTS.flatMap(sourcesUnder)
    .filter((file) => {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      return READINESS_BRANCHES.some((pattern) => pattern.test(text));
    })
    .sort();

describe('exactly one function maps capabilities to readiness', () => {
  it('no consumer outside the wire backstops branches on toolCalling to decide whether a target can run', () => {
    expect(branchingFiles().filter((file) => !WIRE_BACKSTOPS.includes(file))).toEqual([]);
  });

  it.each(WIRE_BACKSTOPS)('the wire backstop %s builds its refusal from agentReadiness', (file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(text).toContain('agentReadiness');
    expect(text).not.toContain("'this target does not support tool calling'");
  });

  it('agentReadiness is defined once, in the protocol capabilities module', () => {
    const definitions = [...CONSUMER_ROOTS, 'packages/protocol/src', 'packages/config/src', 'packages/gateway/src']
      .flatMap(sourcesUnder)
      .filter((file, index, all) => all.indexOf(file) === index)
      .filter((file) => /export const agentReadiness\b|function agentReadiness\b/.test(fs.readFileSync(path.join(root, file), 'utf8')));
    expect(definitions).toEqual(['packages/protocol/src/capabilities.ts']);
  });
});
