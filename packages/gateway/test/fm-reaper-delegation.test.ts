import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'managed', 'fm-processes.ts'), 'utf8');

describe('fm reaper delegation to foundation', () => {
  it('no longer defines a private reapMarkedGroup', () => {
    expect(source).not.toMatch(/\breapMarkedGroup\b/);
  });

  it('finalize reaps through reapMarkedProcesses with the fm label and the child pid as pgid', () => {
    expect(source).toMatch(/\breapMarkedProcesses\(\{[^}]*\bpgid:\s*child\.pid\b[^}]*\}\)/s);
    expect(source).toMatch(/\breapMarkedProcesses\(\{[^}]*\blabel:\s*'fm'[^}]*\}\)/s);
  });

  it('reapStaleFmGroups reaps through reapMarkerDirectory with the fm label', () => {
    expect(source).toMatch(/\breapMarkerDirectory\(\{[^}]*\bdir:\s*markerDirectory\b[^}]*\blabel:\s*'fm'[^}]*\}\)/s);
  });

  it('imports both reapers from @momonga/foundation', () => {
    const imports = /import\s*\{([^}]*)\}\s*from\s*'@momonga\/foundation'/.exec(source)?.[1] ?? '';
    expect(imports).toMatch(/\breapMarkedProcesses\b/);
    expect(imports).toMatch(/\breapMarkerDirectory\b/);
  });
});
