import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportedContextCeiling, reportedContextWindow } from '../src/probe/run-probe.ts';
import { LMSTUDIO_API_V1_MODELS, LMSTUDIO_V1_MODELS } from './detect-kinds-support.ts';

const sourceOf = (relative: string): string => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', relative), 'utf8');

describe('a reported maximum is a ceiling, never the window in force (design-model-names 4.14)', () => {
  it('reads a lone max_context_length as the ceiling and no window', () => {
    expect(reportedContextWindow({ max_context_length: 32768 })).toBeUndefined();
    expect(reportedContextCeiling({ max_context_length: 32768 })).toBe(32768);
  });

  it('reads neither from the measured LM Studio /v1/models answer', () => {
    expect(reportedContextWindow(LMSTUDIO_V1_MODELS)).toBeUndefined();
    expect(reportedContextCeiling(LMSTUDIO_V1_MODELS)).toBeUndefined();
  });

  it('reads the window in force 4096 and the ceiling 32768 from the measured LM Studio /api/v1/models answer', () => {
    expect(reportedContextWindow(LMSTUDIO_API_V1_MODELS)).toBe(4096);
    expect(reportedContextCeiling(LMSTUDIO_API_V1_MODELS)).toBe(32768);
  });

  it('the probe takes the window reader, so a listing with only a maximum falls to the measured search', () => {
    const probe = sourceOf('probe/run-probe.ts');
    expect(probe).toContain('const value = reportedContextWindow(source);');
    expect(probe).toContain('reportedWindowOf(modelsBody, model, healthResult.text) ?? (await searchContextWindow(');
    expect(probe).not.toContain('reportedContextCeiling(source)');
  });

  it('the plan catalog takes the window reader', () => {
    const catalog = sourceOf('plan/catalog.ts');
    expect(catalog).toContain('const contextWindow = reportedContextWindow(entry);');
    expect(catalog).not.toContain('reportedContextCeiling');
  });
});
