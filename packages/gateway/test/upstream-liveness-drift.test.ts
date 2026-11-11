import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.resolve(import.meta.dirname, '..', '..');
const GATEWAY_SRC = path.join(PACKAGES, 'gateway', 'src');
const FOUNDATION_SRC = path.join(PACKAGES, 'foundation', 'src');
const PROCESS_FILE = path.join(GATEWAY_SRC, 'process.ts');

const sourcesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => path.join(dir, entry));

const argumentOf = (text: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '{') depth += 1;
    if (char === ')' || char === '}') depth -= 1;
    if (depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open);
};

const callsOf = (text: string, callee: RegExp): string[] =>
  [...text.matchAll(callee)].map((match) => argumentOf(text, (match.index ?? 0) + match[0].length - 1));

const LIVENESS_NUMBER = /(headersTimeout|bodyTimeout|idleTimeout)(Ms)?\s*:\s*[\d_]+/;

describe('the upstream liveness numbers have one source', () => {
  it('no adapter, pool or client construction carries its own liveness number', () => {
    const offenders = [...sourcesUnder(GATEWAY_SRC), ...sourcesUnder(FOUNDATION_SRC)]
      .flatMap((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return callsOf(text, /(new Agent|createEndpointPool|createUdsClient|create\w+Adapter)\(/g)
          .filter((call) => LIVENESS_NUMBER.test(call))
          .map((call) => `${path.relative(PACKAGES, file)}: ${call.slice(0, 120)}`);
      });
    expect(offenders).toEqual([]);
  });

  it('every adapter the gateway process builds over HTTP receives the liveness from the settings', () => {
    const text = fs.readFileSync(PROCESS_FILE, 'utf8');
    const calls = callsOf(text, /create(ChatCompletions|OpenResponses|Anthropic|Ollama)Adapter\(/g);
    expect(calls.length).toBeGreaterThan(0);
    const common = callsOf(text, /const common = \{/g).join('');
    const withoutLiveness = calls.filter((call) => !call.includes('liveness') && !(call.includes('...common') && common.includes('liveness')));
    expect(withoutLiveness).toEqual([]);
  });
});
