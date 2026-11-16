import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { OBSERVED_DIR, REUSE_STORE, createRepoDigests, currentTestReusePlan, inputsOf, fileFiltersOf, projectsOf, recordFileOf, recordFor, replayedLine, replayedSelected, trackedFilesOf, writeRecord } from './test-reuse.ts';
import type { Observation } from './test-reuse.ts';
import { observedNameOf } from './reuse-observed.ts';

type Observed = { file: string; reads: string[]; whole: boolean };

const isObserved = (value: unknown): value is Observed => {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields['file'] === 'string' && typeof fields['whole'] === 'boolean' && Array.isArray(fields['reads']) && fields['reads'].every((read) => typeof read === 'string');
};

export default class ReuseReporter implements Reporter {
  private filtered = false;
  private readonly pending: Observation[] = [];

  onInit(vitest: { readonly config: { readonly testNamePattern?: RegExp | undefined } }): void {
    this.filtered = vitest.config.testNamePattern !== undefined;
    const plan = currentTestReusePlan();
    if (plan.mode === 'on') fs.rmSync(path.join(plan.root, REUSE_STORE, OBSERVED_DIR), { recursive: true, force: true });
  }

  onTestModuleEnd(testModule: TestModule): void {
    const plan = currentTestReusePlan();
    if (plan.mode === 'off') return;
    const relative = path.relative(plan.root, testModule.moduleId).split(path.sep).join('/');
    const project = testModule.project.name;
    const observedDir = path.join(plan.root, REUSE_STORE, OBSERVED_DIR);
    const prefix = `${observedNameOf(testModule.moduleId)}.`;
    const names = fs.existsSync(observedDir) ? fs.readdirSync(observedDir).filter((name) => name.startsWith(prefix)) : [];
    const observed = names.map((name) => {
      const file = path.join(observedDir, name);
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file);
      if (!isObserved(parsed) || parsed.file !== testModule.moduleId) throw new Error(`${file} is not the observation of ${testModule.moduleId}`);
      return parsed;
    });
    if (testModule.state() !== 'passed' || this.filtered) {
      fs.rmSync(recordFileOf(plan.root, project, relative), { force: true });
      return;
    }
    if (observed.length === 0) throw new Error(`the green test file ${relative} left no observation of its inputs; the reuse recorder is not a setup file of the ${project} project`);
    this.pending.push({ project, file: relative, inputs: inputsOf(plan.root, [testModule.moduleId, ...observed.flatMap((entry) => entry.reads)]), whole: observed.some((entry) => entry.whole) });
  }

  onTestRunEnd(): void {
    const plan = currentTestReusePlan();
    if (plan.mode === 'off') return;
    const live = createRepoDigests(plan.root, trackedFilesOf(plan.root));
    for (const observation of this.pending.splice(0)) {
      const unchanged = observation.inputs.every((input) => live.digestOf(input) === plan.digests.digestOf(input)) && (!observation.whole || live.treeDigest() === plan.digests.treeDigest());
      if (unchanged) writeRecord(recordFileOf(plan.root, observation.project, observation.file), recordFor(observation, plan.digests, plan.globals));
    }
    const count = replayedSelected(plan.replayed, projectsOf(process.argv), fileFiltersOf(process.argv));
    process.stdout.write(`\n${replayedLine(count)}\n`);
  }
}
