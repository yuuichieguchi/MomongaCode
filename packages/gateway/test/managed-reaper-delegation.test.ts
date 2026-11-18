import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'managed', 'processes.ts'), 'utf8');

describe('managed server reaper delegation to foundation (design-managed-servers section 18, item 1)', () => {
  it('no longer defines a private reapMarkedGroup', () => {
    expect(source).not.toMatch(/\breapMarkedGroup\b/);
  });

  it('finalize reaps through reapMarkedProcesses with the one managed server label and the group of the launch as pgid, never a label named for one server', () => {
    expect(source).toMatch(/\breapMarkedProcesses\(\{ marker, pgid, [^}]*\}\)/s);
    expect(source).toMatch(/\breapMarkedProcesses\(\{[^}]*\blabel:\s*MANAGED_SERVER_LABEL\b[^}]*\}\)/s);
    expect(source).toMatch(/export const MANAGED_SERVER_LABEL = 'managed server';/);
    expect(source).not.toMatch(/label:\s*'fm'/);
  });

  it('the start-time reap goes through reapMarkerDirectory with the managed server label and the startup occasion of decision 12', () => {
    const call = /\breapMarkerDirectory\(\{(.*?)\}\);/s.exec(source)?.[1];
    expect(call).toBeDefined();
    expect(call).toMatch(/\bdir:\s*markerDirectory\b/);
    expect(call).toMatch(/\blabel:\s*MANAGED_SERVER_LABEL\b/);
    expect(call).toMatch(/\boccasion:\s*'startup'/);
  });

  it('imports both reapers from @momonga/foundation', () => {
    const imports = /import\s*\{([^}]*)\}\s*from\s*'@momonga\/foundation'/.exec(source)?.[1] ?? '';
    expect(imports).toMatch(/\breapMarkedProcesses\b/);
    expect(imports).toMatch(/\breapMarkerDirectory\b/);
  });
});
