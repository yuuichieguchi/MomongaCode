import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { spendOf } from '../packages/store/src/fold.ts';
import { cfgNames } from './formal/cfg-names.ts';
import { readManifest } from './formal/manifest.ts';

const tlaDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const ledger = fs.readFileSync(path.join(tlaDir, 'BudgetLedger.tla'), 'utf8');
const manifest = readManifest(path.join(tlaDir, 'manifest.json'));

const definitionIn = (name: string): string => {
  const start = ledger.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined`);
  const end = ledger.indexOf('\n\n', start);
  return ledger.slice(start, end === -1 ? undefined : end);
};

const stringsIn = (text: string): string[] => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);

const usage = { input_tokens: 3, output_tokens: 1, total_tokens: 4 };

const SAMPLES: Record<string, RunEventPayload> = {
  'model.responded': { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [], usage } } as unknown as RunEventPayload,
  'usage.charged': { type: 'usage.charged', purpose: 'rejected_answer', inputTokens: 3, outputTokens: 1, totalTokens: 4 } as RunEventPayload,
  'model.requested': { type: 'model.requested', step: 1, attempt: 1, digest: 'd', body: { input: 'x' } } as unknown as RunEventPayload,
  'tool.completed': { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok' } as RunEventPayload,
  'user.message': { type: 'user.message', text: 'go' },
};

describe('BudgetLedger.tla against the ledger of the store, in both directions', () => {
  it('settles a reservation on exactly the events whose write records a spend', () => {
    const settling = stringsIn(definitionIn('SettlingEvents')).sort();
    const spending = Object.entries(SAMPLES)
      .filter(([, event]) => spendOf(event) !== undefined)
      .map(([type]) => type)
      .sort();
    expect(settling).toEqual(spending);
  });

  it('lists the holding row, the deep row and one evidence row per defect, each switch on only in its evidence', () => {
    const rows = manifest.entries.filter((entry) => entry.config.split('.')[0] === 'BudgetLedger');
    expect(rows.map((entry) => [entry.config, entry.expect, entry.tier]).sort()).toEqual(
      [
        ['BudgetLedger', 'holds', 'every-run'],
        ['BudgetLedger.threeRuns', 'holds', 'deep'],
        ['BudgetLedger.releaseBeforeAppend', { violates: 'B2', exitCode: 12 }, 'every-run'],
        ['BudgetLedger.resendNoReserve', { violates: 'B4', exitCode: 12 }, 'every-run'],
        ['BudgetLedger.sweepBeforeChildDone', { violates: 'B7', exitCode: 12 }, 'every-run'],
      ].sort(),
    );
    const switches = { ReleaseBeforeAppend: '.releaseBeforeAppend', ResendNoReserve: '.resendNoReserve', SweepBeforeChildDone: '.sweepBeforeChildDone' };
    for (const row of rows) {
      const { constants } = cfgNames(tlaDir, row.config);
      for (const [name, suffix] of Object.entries(switches)) expect(constants[name] === 'TRUE', `${row.config} ${name}`).toBe(row.config.endsWith(suffix));
    }
  });
});
