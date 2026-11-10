import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createRedactor, validateUntrusted, ruleEnforcementOf } from '@momonga/foundation';
import { createAgentsPort, createChildRuns, createGovernancePort, createHistoryPort, createMemoryPort } from '@momonga/runtime';
import { createNodeSkillFileSystem } from '@momonga/skills';
import { createBuiltinTools, createToolRegistry } from '@momonga/tools';
import type { AnyTool, ToolSet } from '@momonga/tools';
import { makeEnv, unavailableEvidenceRun } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const offeredTools = async (): Promise<readonly AnyTool[]> => {
  const env = await makeEnv();
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
  const skillDirectory = path.join(env.project, '.agents', 'skills', 'lint-skill');
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\nname: lint-skill\ndescription: a skill for the lint\n---\nBody.\n');
  const agentDirectory = path.join(env.project, '.momonga', 'agents');
  fs.mkdirSync(agentDirectory, { recursive: true });
  fs.writeFileSync(path.join(agentDirectory, 'lint-agent.md'), '---\nname: lint-agent\ndescription: an agent for the lint\n---\nYou review code.\n');
  const offered: ToolSet[] = [];
  const toolSet = async (_runId: string, options: { additionalTools?: readonly AnyTool[]; only?: readonly string[] }): Promise<ToolSet> => {
    const registry = createToolRegistry();
    for (const tool of [...createBuiltinTools(), ...(options.additionalTools ?? [])]) registry.register(tool);
    return registry.snapshot();
  };
  env.gateway.script.push(callsStep([{ callId: 'lint-1', name: 'UpdatePlan', args: { entries: [{ content: 'lint', status: 'pending', priority: 'low' }] } }]), textStep('Done.'));
  env.enqueue('Compose the tools');
  await env.runOnce(
    env.worker('worker-lint', {
      tools: {
        toolSet,
        executor: {
          ...env.executor,
          runBatch: async (batch) => {
            offered.push(batch.toolSet);
            return env.executor.runBatch(batch);
          },
        },
      },
      memories: createMemoryPort({ store: env.store, settings: env.settings, evidenceRun: unavailableEvidenceRun }),
      history: createHistoryPort({ store: env.store, settings: env.settings, clock: env.clock, home: env.home, redactor: createRedactor({ credentials: [] }), enforcement: () => ruleEnforcementOf('none') }),
      governance: createGovernancePort({ store: env.store, settings: env.settings }),
      agents: createAgentsPort({
        home: env.home,
        fileSystem: createNodeSkillFileSystem(),
        settings: { trusted: () => env.settings.trustedValue },
        runs: createChildRuns({ store: env.store, modelAliases: async () => ['fm'] }),
      }),
    }),
  );
  const first = offered[0];
  if (first === undefined) throw new Error('the claim never ran a batch, so it offered no tool set');
  return first.tools;
};

describe('lint of every tool a claim offers', () => {
  it('compiles each input and output schema with Ajv strict mode and accepts it through the untrusted-schema boundary', async () => {
    const tools = await offeredTools();
    const names = tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(createBuiltinTools().length);
    expect(new Set(names).size).toBe(names.length);
    const problems: string[] = [];
    for (const tool of tools) {
      for (const [kind, schema] of [['input', tool.inputSchema], ['output', tool.outputSchema]] as const) {
        if (schema === undefined) continue;
        try {
          new Ajv2020.default({ strict: true, allErrors: true }).compile(schema);
          validateUntrusted(`lint:${tool.name}:${kind}`, schema, {});
        } catch (error) {
          problems.push(`${tool.name} ${kind}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['activate_skill', 'Agent', 'MemorySave', 'HistorySearch', 'RulePropose', 'LoadTools']));
  });
});
