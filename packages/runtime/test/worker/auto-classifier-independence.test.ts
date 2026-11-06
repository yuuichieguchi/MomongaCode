import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { FIT_KEY, failingRecord, passingRecord } from '../auto-fit-fixtures.ts';
import type { AutoFitRecord } from '../auto-fit-fixtures.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const SAFE = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });

const runWithRecords = async (records: readonly AutoFitRecord[]) => {
  const env = await makeEnv({ mode: 'auto' });
  const directory = path.join(momongaLayout(env.home).state, 'auto-fit');
  fs.mkdirSync(directory, { recursive: true });
  records.forEach((record, index) => fs.writeFileSync(path.join(directory, `record-${index}.json`), JSON.stringify(record)));
  env.settings.classifierAlias = 'guard';
  env.gateway.capabilitiesByAlias['guard'] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
  const target = path.join(env.project, 'out.txt');
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]), textStep(SAFE), textStep('Written.'));
  const run = env.enqueue('Write out.txt');
  await env.runOnce(env.worker());
  return { env, run, target };
};

describe("the classifier's verdict does not depend on any measurement record (I6.6)", () => {
  it.each([
    ['no record', []],
    ['a failing record', [failingRecord()]],
    ['a passing record', [passingRecord()]],
    ['a stale record', [passingRecord({ key: { ...FIT_KEY, codeDigest: 'older-classifier-code' } })]],
  ] as [string, AutoFitRecord[]][])('allows the call the classifier judged safe with %s', async (_label, records) => {
    const { env, run, target } = await runWithRecords(records);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'allow', alias: 'guard', verdict: 'safe' });
  });
});
