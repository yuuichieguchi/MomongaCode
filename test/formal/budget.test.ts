import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './manifest.ts';

const manifestPath = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla', 'manifest.json');

const recordedRows = (): unknown[] => {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed) || !Array.isArray(parsed.entries)) throw new Error('the TLA manifest has no entries');
  return parsed.entries;
};

const reuseOf = (row: unknown): unknown => (typeof row === 'object' && row !== null && 'measuredReuse' in row ? row.measuredReuse : undefined);

describe('the recorded measurements of the TLC rows', () => {
  it('records every row as measured with reuse off', () => {
    expect(recordedRows().filter((row) => reuseOf(row) !== 'off')).toEqual([]);
  });
});

describe('the CPU budgets of the vitest projects', () => {
  const projectRows = (): Record<string, unknown>[] => {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('vitestProjects' in parsed) || !Array.isArray(parsed.vitestProjects)) throw new Error('the TLA manifest has no vitestProjects');
    return parsed.vitestProjects as Record<string, unknown>[];
  };

  it('records a budget for every project of the vitest config', () => {
    expect(projectRows().map((row) => row['project']).sort()).toEqual(['calibration', 'e2e', 'packaging', 'unit']);
  });

  it('derives every budget as twice the measured CPU, or wall × cores while the CPU is not measured, rounded up plus the start-up CPU', () => {
    const { startupCpuSeconds } = readManifest(manifestPath);
    for (const row of projectRows()) {
      const measured = row['measuredCpuSeconds'];
      const basis = typeof measured === 'number' ? measured : (row['measuredWallSeconds'] as number) * (row['measuredCores'] as number);
      expect(row['budgetCpuSeconds'], String(row['project'])).toBe(Math.ceil(2 * basis) + startupCpuSeconds);
    }
  });
});
