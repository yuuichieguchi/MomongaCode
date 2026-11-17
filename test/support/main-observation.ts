import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCallSites } from 'node:util';
import type { TestProject } from 'vitest/node';
import { recordReads } from './read-recorder.ts';
import { testReuseModeOf } from './reuse-observed.ts';
import { currentTestReusePlan, writeRecordsOf } from './test-reuse.ts';

const MAIN_READS = Symbol.for('momonga.mainProcessReads');

type ReadsHolder = { [MAIN_READS]?: Set<string> };

const REUSE_MACHINERY = ['test-reuse.ts', 'reuse-reporter.ts', 'main-observation.ts', 'read-recorder.ts'].map((name) => path.join(import.meta.dirname, name));

const STACK_DEPTH = 200;

const readByRepositoryCode = (root: string): boolean => {
  const scripts = getCallSites(STACK_DEPTH)
    .slice(1)
    .map((site) => (site.scriptName.startsWith('file:') ? fileURLToPath(site.scriptName) : site.scriptName));
  if (scripts.some((script) => REUSE_MACHINERY.includes(script))) return false;
  return scripts.some((script) => script.startsWith(`${root}${path.sep}`) && !script.includes(`${path.sep}node_modules${path.sep}`));
};

const mainProcessReads = (root: string): Set<string> => {
  const holder = globalThis as ReadsHolder;
  const existing = holder[MAIN_READS];
  if (existing !== undefined) return existing;
  const reads = new Set<string>();
  holder[MAIN_READS] = reads;
  recordReads((file) => {
    if (readByRepositoryCode(root)) reads.add(file);
  });
  return reads;
};

type RunnerWithModules = { readonly evaluatedModules?: { readonly fileToModulesMap: ReadonlyMap<string, unknown> } };

const evaluatedFilesOf = (project: TestProject): string[] => {
  const modules = (project as unknown as { readonly runner: RunnerWithModules }).runner.evaluatedModules;
  if (modules === undefined) throw new Error(`the module runner of project ${project.name} keeps no record of the modules it evaluated, so the test reuse cannot see what its global setup loaded`);
  return [...modules.fileToModulesMap.keys()];
};

export default function setup(project: TestProject): () => void {
  if (testReuseModeOf(process.env) === 'off') return () => undefined;
  const plan = currentTestReusePlan();
  const reads = mainProcessReads(plan.root);
  return () => {
    writeRecordsOf(plan, project.name, [...evaluatedFilesOf(project), ...reads]);
  };
}
