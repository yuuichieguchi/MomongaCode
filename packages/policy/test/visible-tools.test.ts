import { describe, expect, it } from 'vitest';
import { modelVisibleTools } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';
import { makeLayout, ruleIn } from './helpers.ts';

const TOOLS: PolicyTool[] = [
  { name: 'Read', kind: 'read', sideEffect: 'read_only' },
  { name: 'Grep', kind: 'search', sideEffect: 'read_only' },
  { name: 'Edit', kind: 'edit', sideEffect: 'write' },
  { name: 'Bash', kind: 'execute', sideEffect: 'exec' },
  { name: 'UpdatePlan', kind: 'think', sideEffect: 'read_only' },
  { name: 'mcp__srv__run', kind: 'other', sideEffect: 'exec' },
  { name: 'mcp__srv__list', kind: 'other', sideEffect: 'read_only' },
  { name: 'mcp__other__x', kind: 'other', sideEffect: 'exec' },
];

const names = (tools: PolicyTool[]): string[] => tools.map((t) => t.name);

describe('modelVisibleTools', () => {
  it('shows every tool without rules in default mode', () => {
    expect(names(modelVisibleTools(TOOLS, { mode: 'default', rules: [] }))).toEqual(names(TOOLS));
  });

  it('hides tools denied without a specifier, and whole MCP servers', () => {
    const layout = makeLayout();
    const make = ruleIn(layout);
    const rules = [make('deny', 'Bash'), make('deny', 'Read(./secret/**)'), make('deny', 'mcp__srv'), make('ask', 'Grep'), make('allow', 'Edit')];
    expect(names(modelVisibleTools(TOOLS, { mode: 'default', rules }))).toEqual(['Read', 'Grep', 'Edit', 'UpdatePlan', 'mcp__other__x']);
  });

  it('hides a single denied MCP tool', () => {
    const layout = makeLayout();
    const rules = [ruleIn(layout)('deny', 'mcp__srv__run')];
    expect(names(modelVisibleTools(TOOLS, { mode: 'default', rules }))).not.toContain('mcp__srv__run');
    expect(names(modelVisibleTools(TOOLS, { mode: 'default', rules }))).toContain('mcp__srv__list');
  });

  it('shows read_only tools and Bash in plan mode, and hides Edit and MCP exec tools', () => {
    expect(names(modelVisibleTools(TOOLS, { mode: 'plan', rules: [] }))).toEqual(['Read', 'Grep', 'Bash', 'UpdatePlan', 'mcp__srv__list']);
  });

  it('still hides Bash in plan mode under a blanket deny rule', () => {
    const layout = makeLayout();
    expect(names(modelVisibleTools(TOOLS, { mode: 'plan', rules: [ruleIn(layout)('deny', 'Bash')] }))).not.toContain('Bash');
  });

  it('still hides denied tools in bypassPermissions', () => {
    const layout = makeLayout();
    expect(names(modelVisibleTools(TOOLS, { mode: 'bypassPermissions', rules: [ruleIn(layout)('deny', 'Edit')] }))).not.toContain('Edit');
  });
});

describe('modelVisibleTools for tools that serve another tool', () => {
  const WITH_JOB_TOOLS: PolicyTool[] = [
    ...TOOLS,
    { name: 'BashOutput', kind: 'execute', sideEffect: 'read_only', companionOf: 'Bash' },
    { name: 'KillBash', kind: 'execute', sideEffect: 'write', companionOf: 'Bash' },
  ];
  const ONLY_JOB_TOOLS = ['BashOutput', 'KillBash'];
  const jobToolsIn = (visible: PolicyTool[]): string[] => names(visible).filter((name) => ONLY_JOB_TOOLS.includes(name));

  it('offers them with the tool they serve', () => {
    expect(jobToolsIn(modelVisibleTools(WITH_JOB_TOOLS, { mode: 'default', rules: [], jobsRunning: false }))).toEqual(ONLY_JOB_TOOLS);
  });

  it('offers neither when the served tool is denied and no job runs', () => {
    const rules = [ruleIn(makeLayout())('deny', 'Bash')];
    expect(jobToolsIn(modelVisibleTools(WITH_JOB_TOOLS, { mode: 'default', rules, jobsRunning: false }))).toEqual([]);
  });

  it('offers both when the served tool is denied and a job runs', () => {
    const rules = [ruleIn(makeLayout())('deny', 'Bash')];
    const visible = modelVisibleTools(WITH_JOB_TOOLS, { mode: 'default', rules, jobsRunning: true });
    expect(jobToolsIn(visible)).toEqual(ONLY_JOB_TOOLS);
    expect(names(visible)).not.toContain('Bash');
  });

  it('hides one of them under its own deny rule even when a job runs', () => {
    const rules = [ruleIn(makeLayout())('deny', 'KillBash')];
    expect(jobToolsIn(modelVisibleTools(WITH_JOB_TOOLS, { mode: 'default', rules, jobsRunning: true }))).toEqual(['BashOutput']);
  });

  it('offers neither when the served tool does not exist and no job runs', () => {
    const withoutBash = WITH_JOB_TOOLS.filter((tool) => tool.name !== 'Bash');
    expect(jobToolsIn(modelVisibleTools(withoutBash, { mode: 'default', rules: [], jobsRunning: false }))).toEqual([]);
  });

  it('follows the served tool in plan mode', () => {
    expect(jobToolsIn(modelVisibleTools(WITH_JOB_TOOLS, { mode: 'plan', rules: [], jobsRunning: false }))).toEqual(ONLY_JOB_TOOLS);
  });
});
