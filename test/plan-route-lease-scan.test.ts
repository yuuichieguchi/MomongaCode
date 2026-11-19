import fs from 'node:fs';
import path from 'node:path';
import { PLAN_ROUTES } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';

const APP = path.resolve(import.meta.dirname, '..', 'packages', 'gateway', 'src', 'server', 'app.ts');

const ROUTE = /app\.(?:get|post)\(planRoute\(PLAN_ROUTES\.(\w+)\)/g;

const routeSegments = (source: string): { name: string; segment: string }[] => {
  const matches = [...source.matchAll(ROUTE)];
  const end = source.indexOf('return app;');
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const next = matches[index + 1];
    const stop = next?.index ?? end;
    return { name: match[1] ?? '', segment: source.slice(start, stop) };
  });
};

describe('O-R5-6 (M) 5.2: the plan routes that take the pinned lease', () => {
  it('only accounts, signInComplete and accountResume take the pinned lease', () => {
    const segments = routeSegments(fs.readFileSync(APP, 'utf8'));
    const names = segments.map((entry) => entry.name).sort();
    expect(names).toEqual(Object.keys(PLAN_ROUTES).sort());
    const leased = new Set(segments.filter((entry) => entry.segment.includes('withPinnedServices(')).map((entry) => entry.name));
    expect([...leased].sort()).toEqual(['accountResume', 'accounts', 'signInComplete']);
    const closing = segments.filter((entry) => entry.segment.includes('closedOr')).map((entry) => entry.name).sort();
    expect(closing).toEqual(['accountModels', 'accountRename', 'signInComplete', 'signOut']);
  });
});
