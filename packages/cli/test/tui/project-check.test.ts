import { describe, expect, it } from 'vitest';
import type { PickRequest, TextRequest } from '../../src/tui/picker.tsx';
import { DECLINE_CHECK_ROW, TYPE_CHECK_ROW, askProjectCheck, useCheckRow } from '../../src/tui/project-check.ts';

const CHECKS = [
  { source: 'package.json', command: 'npm test' },
  { source: 'Makefile', command: 'make test' },
] as const;

const overlay = (row: string | undefined, typed?: string) => {
  const asked: PickRequest[] = [];
  const prompted: TextRequest[] = [];
  return {
    asked,
    prompted,
    choose: async (request: PickRequest) => {
      asked.push(request);
      const index = request.rows.findIndex((entry) => entry.label === row);
      return index < 0 ? undefined : { index, alt: false };
    },
    promptText: async (request: TextRequest) => {
      prompted.push(request);
      return typed;
    },
  };
};

describe('the question that proposes the check a folder declares', () => {
  it('offers each declared check, a typed command and a decline', async () => {
    const ports = overlay(undefined);
    await askProjectCheck(CHECKS, ports);
    expect(ports.asked[0]?.rows.map((entry) => entry.label)).toEqual([useCheckRow(CHECKS[0]), useCheckRow(CHECKS[1]), TYPE_CHECK_ROW, DECLINE_CHECK_ROW]);
  });

  it('accepts the chosen declared check', async () => {
    expect(await askProjectCheck(CHECKS, overlay(useCheckRow(CHECKS[1])))).toEqual({ commands: ['make test'] });
  });

  it('accepts a typed command, starting from the first declared one', async () => {
    const ports = overlay(TYPE_CHECK_ROW, '  npm run test:unit ');
    expect(await askProjectCheck(CHECKS, ports)).toEqual({ commands: ['npm run test:unit'] });
    expect(ports.prompted[0]?.initial).toBe('npm test');
    expect(ports.prompted[0]?.validate('   ')).toBeDefined();
  });

  it('keeps a decline', async () => {
    expect(await askProjectCheck(CHECKS, overlay(DECLINE_CHECK_ROW))).toEqual({ declined: true });
  });

  it('stores nothing when the question is left, so it is asked at the next start', async () => {
    expect(await askProjectCheck(CHECKS, overlay(undefined))).toBeUndefined();
    expect(await askProjectCheck(CHECKS, overlay(TYPE_CHECK_ROW, undefined))).toBeUndefined();
  });
});
