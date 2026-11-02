import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { protectedSetFor } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { SubjectTool, Witness } from '../src/decision-model.ts';
import { predictDecision } from '../src/queries.ts';
import { isMismatch } from '../src/report.ts';
import { replayWitness } from '../src/replay.ts';
import { buildQueryContext } from '../src/verify.ts';
import { caseInsensitiveFs, caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';
import type { Layout, RuleSpec } from './harness.ts';

const z3 = useZ3();

const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const PATH_RULES: readonly string[] = [
  'Read(./a/**)',
  'Read(./a/b.txt)',
  'Read(**/*.pem)',
  'Read(./*.md)',
  'Read(./[a-b]/?.txt)',
  'Read(./a/**/d.md)',
  'Edit(./a/**)',
  'Edit(./b/*.txt)',
  'Write(./c)',
  'Glob(./a/**)',
  'Grep(./b/**)',
  'Read(~/h/**)',
  'Edit(~/.ssh/**)',
  'Read(./.git/**)',
];
const COMMAND_RULES: readonly string[] = [
  'Bash(git:*)',
  'Bash(git push:*)',
  'Bash(rm:*)',
  'Bash(ls)',
  'Bash(npm run build)',
  'Bash(npm run:*)',
  'Bash(echo:*)',
  'Bash(git status)',
  'Bash(cat:*)',
  'Bash(bash:*)',
  'Bash',
];
const MCP_RULES: readonly string[] = ['mcp__srv', 'mcp__srv__tool', 'mcp__other__x'];
const EFFECTS = ['allow', 'ask', 'deny'] as const;

const COMMANDS: readonly string[] = [
  'git status',
  'git push origin',
  'git -C . push',
  'git  push',
  'git',
  'git commit -m push',
  'ls',
  'ls -la',
  'ls rm',
  'rm -rf x',
  '/usr/bin/rm x',
  'echo rm x',
  'npm run build',
  'npm run test',
  'npm run  build',
  'cat a.txt',
  'bash -c x',
  'git - push',
  'cat *.md',
  'cat {a,b}',
  'cat /etc/*',
  'ls src/*.py',
  'rm -rf .',
  'rm -rf .git',
  'touch .git/hooks/pre-commit',
  'echo x > .git/config',
];

const pathsIn = (layout: Layout): string[] => [
  `${layout.project}/a/b.txt`,
  `${layout.project}/a/c/d.md`,
  `${layout.project}/b/x.txt`,
  `${layout.project}/c`,
  `${layout.project}/notes.md`,
  `${layout.project}/key.pem`,
  `${layout.project}/a/b.pem`,
  `${layout.home}/h/f`,
  `${layout.home}/.ssh/id`,
  `${layout.outside}/z`,
  `${layout.project}/.git/hooks/pre-commit`,
  `${layout.project}/.git/config`,
  `${layout.project}/.momonga/x`,
  `${layout.project}/A/B.TXT`,
  `${layout.project}/Key.PEM`,
  `${layout.project}/.GIT/config`,
  `${layout.home}/H/f`,
  `${layout.home}/.SSH/id`,
];

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

type Focus = 'path' | 'command' | 'mcp';

const FOCUSES: readonly Focus[] = ['path', 'command', 'command', 'mcp', 'path'];

const RULE_POOLS: Readonly<Record<Focus, readonly string[]>> = { path: PATH_RULES, command: COMMAND_RULES, mcp: MCP_RULES };

const ruleSetFor = (random: () => number, focus: Focus): RuleSpec[] => {
  const size = 1 + Math.floor(random() * 5);
  const mixed = [...PATH_RULES, ...COMMAND_RULES, ...MCP_RULES];
  return Array.from({ length: size }, (): RuleSpec => {
    const text = pick(random, random() < 0.8 ? RULE_POOLS[focus] : mixed);
    return [pick(random, EFFECTS), text];
  });
};

const commandsDerivedFrom = (specs: readonly RuleSpec[]): string[] =>
  specs.flatMap(([, text]) => {
    const body = /^Bash\((.*?)(:\*)?\)$/.exec(text)?.[1];
    if (body === undefined) return [];
    const words = body.split(' ');
    const [program, ...rest] = words;
    return [
      body,
      `${body} extra`,
      `${body}  extra`,
      `echo ${body}`,
      `ls ${body}`,
      `/usr/bin/${body}`,
      `${program as string} -x ${rest.join(' ')}`.trim(),
      `${program as string} -C . ${rest.join(' ')}`.trim(),
      `${program as string} sub ${rest.join(' ')}`.trim(),
      rest.length > 0 ? `${program as string}  ${rest.join('  ')}` : `${program as string}/`,
    ];
  });

const TRIALS = 30;
const INPUTS_PER_TRIAL = 24;

describe('the model agrees with the decision code', () => {
  it.each([
    ['case sensitive volume', caseSensitiveFs],
    ['case insensitive volume', caseInsensitiveFs],
  ] as const)('on generated rule sets and inputs, %s', async (_label, makeFs) => {
    const random = mulberry32(0x5eed);
    const layout = makeLayout();
    let compared = 0;
    let agreed = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const focus = pick(random, FOCUSES);
      const specs = ruleSetFor(random, focus);
      const mode = pick(random, PERMISSION_MODES);
      const fileSystem = makeFs();
      const roots = [layout.project];
      const rules = rulesOf(layout, specs, makeFs === caseInsensitiveFs ? 'user' : 'project');
      const context = buildQueryContext(z3.engine().api, {
        rules,
        roots,
        mode,
        home: layout.home,
        cwd: layout.project,
        protectedSet: protectedSetFor(roots, fileSystem),
        fs: fileSystem,
        secretLocations: [sshLocation(layout)],
        exemptDirectory: null,
        timeoutMs: 30_000,
      });
      const inputs: Array<[SubjectTool, Witness]> = [];
      for (let count = 0; count < INPUTS_PER_TRIAL; count += 1) {
        const kind = random() < 0.85 ? { path: 0.2, command: 0.6, mcp: 0.95 }[focus] : random();
        if (kind < 0.4) {
          const tool = pick(random, ['Read', 'Glob', 'Grep', 'Write'] as const);
          const target = pick(random, pathsIn(layout));
          inputs.push([tool, { kind: 'path', tool, access: tool === 'Write' ? 'write' : 'read', requested: target, resolved: target }]);
        } else if (kind < 0.85) {
          const derived = commandsDerivedFrom(specs);
          const command = derived.length > 0 && random() < 0.7 ? pick(random, derived) : pick(random, COMMANDS);
          inputs.push(['Bash', { kind: 'command', command, defaultAllow: false }]);
        } else {
          const [server, tool] = pick(random, [['srv', 'tool'], ['srv', 'other'], ['other', 'x'], ['third', 'y']] as const);
          inputs.push(['mcp', { kind: 'mcp', server, tool, readOnly: random() < 0.5 }]);
        }
      }
      for (const [tool, witness] of inputs) {
        const prediction = await predictDecision(context, tool, witness);
        if (prediction === undefined) continue;
        const replay = replayWitness(context.env, tool, witness, prediction);
        if ('skipped' in replay) continue;
        compared += 1;
        if (!isMismatch(replay)) agreed += 1;
        else throw new Error(`model and decision code disagree\nmode: ${mode}\nrules: ${JSON.stringify(specs)}\ninput: ${JSON.stringify(witness)}\nreplay: ${JSON.stringify(replay)}`);
      }
    }
    expect(agreed).toBe(compared);
    expect(compared).toBeGreaterThan(TRIALS * 3);
  }, 600_000);

  it('uses a project-relative layout so the generated paths sit under the compiled roots', () => {
    const layout = makeLayout();
    expect(path.relative(layout.project, `${layout.project}/a/b.txt`)).toBe('a/b.txt');
  });
});
