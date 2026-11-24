import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GENERAL_PURPOSE_AGENT } from '../packages/agents/src/builtin.ts';
import { DEFAULT_SLASH_COMMANDS, sessionSlashCommands } from '../packages/cli/src/tui/commands/index.ts';
import { referenceNames, renderReference } from '../scripts/reference.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const proseOf = (markdown: string): string => markdown.replace(/^```[\s\S]*?^```$/gm, '');

const inlineCode = (markdown: string): string[] => [...proseOf(markdown).matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');

const commandPathOf = (written: string): string => {
  const words: string[] = [];
  for (const word of written.split(/\s+/).slice(1)) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    words.push(word);
  }
  return words.join(' ');
};

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

const DOC_FILES = ['README.md', 'site/docs/guide.md', 'site/docs/judging-models.md'] as const;

describe('the generated reference', () => {
  it('docs/reference.md is removed and scripts/reference.ts renders all reference sections from the product', async () => {
    expect(fs.existsSync(path.join(root, 'docs/reference.md'))).toBe(false);
    const rendered = await renderReference();
    for (const heading of ['## Slash commands', '## Root options', '## Commands', '## Settings keys', '## Environment variables', '## Exit codes', '## Key bindings', '## Built-in tools']) {
      expect(rendered).toContain(heading);
    }
  });

  it('every command, settings key and environment variable the documentation names is one the reference lists', async () => {
    const names = await referenceNames();
    const unknown: string[] = [];
    for (const file of DOC_FILES) {
      for (const written of inlineCode(read(file))) {
        if (written.startsWith('momonga ')) {
          const command = commandPathOf(written);
          if (command !== '' && !names.commands.has(command)) unknown.push(`${file}: command ${command}`);
          continue;
        }
        const [name = ''] = written.split('=');
        if (ENVIRONMENT_NAME.test(name)) {
          if (!names.environment.has(name)) unknown.push(`${file}: environment variable ${name}`);
          continue;
        }
        const [first = ''] = written.split('.');
        if (/^[a-zA-Z.]+$/.test(written) && written.includes('.') && names.topLevelSettings.has(first) && !names.settings.has(written)) unknown.push(`${file}: settings key ${written}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('every option the documentation writes after a momonga command is one that command or the root takes', async () => {
    const names = await referenceNames();
    const written = DOC_FILES.flatMap((file) => {
      const content = read(file);
      const shellLines = [...content.matchAll(/^ *```(?:sh|text)?\n([\s\S]*?)^ *```$/gm)].flatMap((block) => (block[1] ?? '').split('\n').map((line) => line.trim()));
      return [...inlineCode(content), ...shellLines]
        .filter((text) => text.startsWith('momonga '))
        .map((text) => ({ file, text }));
    });
    const unknown = written.flatMap(({ file, text }) => {
      const command = commandPathOf(text);
      const taken = names.options.get(command) ?? new Set<string>();
      return text
        .split(/\s+/)
        .map((word) => word.replace(/^\[/, '').replace(/[\]|].*$/, '').split('=')[0] ?? '')
        .filter((flag) => /^--?[a-zA-Z]/.test(flag) && !taken.has(flag))
        .map((flag) => `${file}: ${text}: ${flag}`);
    });
    expect(unknown).toEqual([]);
  });

  it('the guide names exactly the settings keys a project or local settings file cannot set', async () => {
    const names = await referenceNames();
    const line = read('site/docs/guide.md').split('\n').find((text) => text.startsWith('Project and local settings cannot set'));
    expect(line).toBeDefined();
    const sentence = (line ?? '').split(';')[0] ?? '';
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    expect([...listed].sort()).toEqual([...names.userOnlySettings].sort());
  });

  it('every slash command the documentation names is one the interactive session offers', async () => {
    const names = await referenceNames();
    const written = DOC_FILES.flatMap((file) =>
      inlineCode(read(file))
        .flatMap((text) => text.split(/,\s*/))
        .flatMap((text) => {
          const match = /^\/([a-z][a-z-]*)(?:\s|$)/.exec(text);
          return match === null ? [] : [match[1] ?? ''];
        }),
    );
    expect(written.length).toBeGreaterThan(20);
    expect(written.filter((name) => !names.slashCommands.has(name))).toEqual([]);
  });
});

describe('the slash commands of the reference', () => {
  it('lists every command of the interactive session, first, with its other names, usage, description and subcommands', async () => {
    const reference = await renderReference();
    const flows = new Proxy({}, { get: () => () => undefined }) as never;
    const commands = sessionSlashCommands(DEFAULT_SLASH_COMMANDS, flows);
    const section = reference.slice(reference.indexOf('## Slash commands'), reference.indexOf('## Root options'));
    expect(reference.indexOf('## Slash commands')).toBeLessThan(reference.indexOf('## Root options'));
    expect(reference.split('\n').filter((line) => line.startsWith('## '))[0]).toBe('## Slash commands');
    const rows = section.split('\n').filter((line) => line.startsWith('| `/'));
    for (const command of commands) {
      const usage = `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}`.replaceAll('|', '\\|');
      const names = [`\`${usage}\``, ...(command.otherNames ?? []).map((name) => `\`/${name}\``)].join(', ');
      expect(rows, command.name).toContain(`| ${names} | ${command.description.replaceAll('|', '\\|').replaceAll('<', '\\<')} |`);
      for (const subcommand of command.subcommands ?? []) expect(section, `${command.name} ${subcommand.name}`).toContain(`| \`/${command.name} ${subcommand.name}`);
    }
    expect(section).toContain('`/<skill> <task>`');
    expect(section).toContain('### /memory');
    expect(section).toContain('| `/memory review accept <id>` | accept one memory under review |');
  });
});

describe('the settings table of the reference', () => {
  const rowOf = (markdown: string, key: string): string => markdown.split('\n').find((line) => line.startsWith(`| \`${key}\` |`)) ?? '';

  it('states the default and the unit the schema holds for each key', async () => {
    const reference = await renderReference();
    expect(reference).toContain('| Key | Value | Default | Unit | Layer |');
    expect(rowOf(reference, 'memory.forgetAfterDays')).toMatch(/\| `90` \| days \|/);
    expect(rowOf(reference, 'sandboxNetwork')).toContain('`"ask"`');
    expect(rowOf(reference, 'context.autoCompact')).toContain('| `true` |');
    expect(rowOf(reference, 'context.compactAt')).toMatch(/^\| `context\.compactAt` \| integer\b.*\| `70` \| percent \| user, project, local \|$/);
    expect(rowOf(reference, 'sandbox')).toContain('`"seatbelt"` on darwin');
    expect(rowOf(reference, 'hooks.<name>[].hooks[].timeout')).toMatch(/\| `600`; `UserPromptSubmit`: `30` \| seconds \|/);
    expect(rowOf(reference, 'limits.maxCostUsd')).toContain('| USD |');
  });
});

describe('the built-in agents of the reference', () => {
  it('lists every built-in agent with its description under the built-in tools', async () => {
    const reference = await renderReference();
    const section = reference.slice(reference.indexOf('### Built-in agents'));
    expect(section).toContain(`| \`${GENERAL_PURPOSE_AGENT.name}\` | ${GENERAL_PURPOSE_AGENT.description} |`);
    expect(reference.indexOf('### Built-in agents')).toBeGreaterThan(reference.indexOf('## Built-in tools'));
  });
});
