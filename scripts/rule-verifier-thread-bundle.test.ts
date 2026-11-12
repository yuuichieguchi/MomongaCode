import fs from 'node:fs';
import path from 'node:path';
import type { BuildOptions, Metafile } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRule } from '@momonga/config';
import { momongaLayout, nodeFileSystem, systemClock } from '@momonga/foundation';
import { createPolicyFilesystem } from '@momonga/tools';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';
import { Z3_MANIFEST_ASSET, parseZ3Manifest } from '@momonga/verify';
import { RULE_VERIFY_LOAD_ALLOWANCE_MS, createRuleVerifier } from '../packages/runtime/src/process/rule-verifier.ts';
import { RULE_VERIFY_BUDGET_MS } from '@momonga/protocol';
import type { RuleSolverHost } from '../packages/runtime/src/process/rule-verifier.ts';
import { systemTimers } from '../packages/runtime/src/service/timers.ts';
import { bundleRuleVerifierThread, repoRoot, ruleVerifierThreadEntry } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { buildZ3Assets } from './z3-assets.ts';

const metafiles = vi.hoisted(() => [] as Metafile[]);

vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    build: async (options: BuildOptions) => {
      const result = await actual.build({ ...options, metafile: true });
      metafiles.push(result.metafile);
      return result;
    },
  };
});

const packageOf = (input: string): string | undefined => /^packages\/([^/]+)\//.exec(input)?.[1];

describe('the bundle of the verification thread', () => {
  let root = '';
  let code = '';
  let inputs: string[] = [];
  let assets: Record<string, Uint8Array> = {};

  beforeAll(async () => {
    root = fs.realpathSync(createTempRoot());
    metafiles.length = 0;
    code = await bundleRuleVerifierThread();
    inputs = Object.keys(metafiles[0]?.inputs ?? {});
    const files = await buildZ3Assets(path.join(root, 'work'), import.meta.url);
    assets = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, new Uint8Array(fs.readFileSync(file))]));
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('holds the thread entry, the verifier and the modules the verifier needs, and no module of the tools package', () => {
    const packages = [...new Set(inputs.flatMap((input) => packageOf(input) ?? []))].sort();
    expect(inputs).toContain(path.relative(repoRoot, ruleVerifierThreadEntry));
    expect(packages).toContain('verify');
    expect(packages).toContain('policy');
    expect(inputs.filter((input) => packageOf(input) === 'tools')).toEqual([]);
    expect(inputs.filter((input) => packageOf(input) === 'runtime')).toEqual([path.relative(repoRoot, ruleVerifierThreadEntry)]);
    expect(packages.filter((name) => ['sandbox', 'store', 'mcp', 'gateway', 'cli'].includes(name))).toEqual([]);
  });

  it(
    'runs in a thread that extracts the bundled solver into the folder of the executables, loads it and proves a rule set',
    async () => {
      const home = path.join(root, 'home');
      const work = path.join(root, 'project');
      const executables = path.join(root, 'executables');
      fs.mkdirSync(home);
      fs.mkdirSync(work);
      const manifest = parseZ3Manifest(new TextDecoder().decode(assets[Z3_MANIFEST_ASSET]));
      const host: RuleSolverHost = {
        loadVerifier: () => import('@momonga/verify'),
        solverVersion: async () => `z3 ${manifest.contentHash}`,
        recipe: async (verifier) => {
          const bundled = await verifier.ensureBundledZ3({ asset: (name) => assets[name] as Uint8Array, executablesRoot: executables, random: () => 0.5, lock: testKernelLock(), files: nodeFileSystem });
          return { kind: 'bundled', entry: bundled.entry, wasmBinary: bundled.wasmBinary };
        },
        threadCode: code,
      };
      const verifier = createRuleVerifier({ host, fs: createPolicyFilesystem(), paths: momongaLayout(home, process.platform, {}), timers: systemTimers, bashPath: () => '/bin/bash', clock: systemClock, budgetMs: RULE_VERIFY_BUDGET_MS, startBoundMs: RULE_VERIFY_LOAD_ALLOWANCE_MS });
      const rule = (text: string, effect: 'allow' | 'deny') => parseRule(text, { effect, origin: 'user', source: path.join(home, '.momonga', 'settings.json'), settingsRoot: home, home, cwd: work });

      const input = await verifier.inputOf(
        { unixSockets: { kind: 'limited', allowed: [] }, rules: [rule('Bash', 'allow'), rule('Bash(git push:*)', 'deny')], roots: [work], mode: 'manual', home, cwd: work, exemptDirectory: path.join(home, '.momonga', 'tmp', 'sessions', 's1'), enforcement: 'exact-paths', secrets: [] },
        NEVER_CANCELLED,
      );
      const verification = await verifier.report(input, new AbortController().signal);

      expect(verification.verdict).toMatchObject({ verdict: 'proved', solver: `z3 ${manifest.contentHash}`, refuted: [], unknown: [] });
      expect(verification.report).toContain('policy verification of 2 rule(s) in manual mode');
      expect(verification.verdict.phases?.map((entry) => entry.phase).slice(0, 3)).toEqual(['thread-start', 'load', 'instantiate']);
      expect(fs.readdirSync(executables)).toEqual([`z3-${manifest.contentHash.slice(0, 16)}`]);
    },
    UNBOUNDED_BUILD_WAIT_MS,
  );
});
