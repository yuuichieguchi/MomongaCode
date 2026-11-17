import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, PERMISSION_MODE_DESCRIPTIONS } from '@momonga/protocol';
import type { AgentView, SkillView } from '@momonga/protocol';
import { readSettingsSnapshot } from '@momonga/config';
import { AGENTS_TITLE } from '../../src/tui/commands/agents.ts';
import { CREATE_FROM_TEMPLATE_ROW, OPEN_IN_EDITOR_ROW, SKILLS_TITLE } from '../../src/tui/commands/skills.ts';
import { NOTHING_TO_COPY } from '../../src/tui/commands/copy.ts';
import { OPEN_AGENTS_FILE_ROW } from '../../src/tui/commands/memory.ts';
import { ALSO_START_LABEL, MODE_PICKER_TITLE, modeToastText } from '../../src/tui/slash.ts';
import { contextOf, runSlash } from './slash-context.ts';
import { freshPlace } from './settings-harness.tsx';

describe('the one-line toast of a mode change (design 5.2, 8.1)', () => {
  it.each(PERMISSION_MODES)('names what %s does from the one mode table', (mode) => {
    expect(modeToastText(mode)).toBe(`${mode}: ${PERMISSION_MODE_DESCRIPTIONS[mode]}`);
  });
});

describe('/mode (design-screens 12.1 row 11)', () => {
  it('opens a picker of the modes with what each does; enter uses the mode now', async () => {
    const { context, recorded } = contextOf({}, {}, { choices: [{ index: 2, alt: false }] });
    await runSlash('mode', '', context);
    expect(recorded.picks[0]?.title).toBe(MODE_PICKER_TITLE);
    expect(recorded.picks[0]?.rows.map((row) => row.label)).toEqual(PERMISSION_MODES.map((mode) => `${mode}  ${PERMISSION_MODE_DESCRIPTIONS[mode]}`));
    expect(recorded.picks[0]?.alt?.label).toBe(ALSO_START_LABEL);
    expect(recorded.modes).toEqual(['plan']);
  });

  it('tab in the picker and /mode <m> --start also write the start mode of the user settings', async () => {
    const place = freshPlace();
    const picked = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project } }, { choices: [{ index: 1, alt: true }] });
    await runSlash('mode', '', picked.context);
    expect(picked.recorded.modes).toEqual(['acceptEdits']);
    const snapshotOf = async () => readSettingsSnapshot({ env: process.env, home: place.home, projectDir: place.project, trusted: true, signal: new AbortController().signal });
    expect(JSON.stringify((await snapshotOf()).layers.find((layer) => layer.layer === 'user')?.document)).toContain('"defaultMode":"acceptEdits"');
    const typed = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project } });
    await runSlash('mode', 'plan --start', typed.context);
    expect(typed.recorded.modes).toEqual(['plan']);
    expect(JSON.stringify((await snapshotOf()).layers.find((layer) => layer.layer === 'user')?.document)).toContain('"defaultMode":"plan"');
  });
});

describe('/tui mouse and /tui copy-on-select (design-screens 12.1 rows 2, 3)', () => {
  it('stores tui.mouse and says it applies from the next start', async () => {
    const { context, recorded } = contextOf();
    await runSlash('tui', 'mouse off', context);
    expect(recorded.stored).toEqual([['mouse', false]]);
    expect(recorded.infos).toEqual(['Mouse: off  applies from the next start']);
  });

  it('stores tui.copyOnSelect and says it applies now', async () => {
    const { context, recorded } = contextOf();
    await runSlash('tui', 'copy-on-select on', context);
    expect(recorded.stored).toEqual([['copyOnSelect', true]]);
    expect(recorded.infos).toEqual(['Copy on select: on  applies now']);
  });

  it('refuses a value other than on or off', async () => {
    const { context, recorded } = contextOf();
    await runSlash('tui', 'mouse maybe', context);
    expect(recorded.stored).toEqual([]);
    expect(recorded.infos).toEqual(['usage: /tui [fullscreen|scrollback] | /tui mouse on|off | /tui copy-on-select on|off']);
  });
});

describe('/copy (N-SCREEN)', () => {
  it('copies the selection through the clipboard routes and shows the toast', async () => {
    const { context, recorded, backend } = contextOf({ clipboard: { selected: () => ({ kind: 'text', text: 'chosen text' }), lastAnswer: () => 'the answer' } });
    await runSlash('copy', '', context);
    expect(backend.calls).toContain('copy:chosen text');
    expect(recorded.toasts).toEqual(['Copied 11 characters']);
  });

  it('copies the last answer when nothing is selected, and says so when there is nothing', async () => {
    const answered = contextOf({ clipboard: { selected: () => undefined, lastAnswer: () => 'the answer' } });
    await runSlash('copy', '', answered.context);
    expect(answered.backend.calls).toContain('copy:the answer');
    const empty = contextOf();
    await runSlash('copy', '', empty.context);
    expect(empty.recorded.infos).toEqual([NOTHING_TO_COPY]);
  });
});

const SKILL: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'user', location: '/home/me/.momonga/skills/pdf/SKILL.md' };
const AGENT: AgentView = { name: 'reviewer', description: 'Reviews a change', scope: 'user', location: '/home/me/.momonga/agents/reviewer.md' };

describe('/skills and /agents (design-screens 12.1 row 41)', () => {
  it('lists the skill files with the two rows, and opens a file in $EDITOR', async () => {
    const { context, recorded } = contextOf({}, { skills: [SKILL] }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }] });
    await runSlash('skills', '', context);
    expect(recorded.picks[0]?.title).toBe(SKILLS_TITLE);
    expect(recorded.picks[0]?.rows.map((row) => row.label)).toEqual([`pdf  user  ${SKILL.location}`, CREATE_FROM_TEMPLATE_ROW]);
    expect(recorded.picks[1]?.rows.map((row) => row.label)).toEqual([OPEN_IN_EDITOR_ROW]);
    expect(recorded.opened).toEqual([SKILL.location]);
  });

  it('creates an agent from a template in the user folder and opens it', async () => {
    const place = freshPlace();
    const { context, recorded } = contextOf({}, { agents: [AGENT], settingsPlace: { home: place.home, projectDir: place.project } }, { choices: [{ index: 1, alt: false }], texts: ['helper'] });
    await runSlash('agents', '', context);
    expect(recorded.picks[0]?.title).toBe(AGENTS_TITLE);
    const file = path.join(place.home, '.momonga', 'agents', 'helper.md');
    expect(recorded.opened).toEqual([file]);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^---\nname: helper\ndescription: /);
  });

  it('creates a skill from a template and refuses a name whose file exists', async () => {
    const place = freshPlace();
    const first = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project } }, { choices: [{ index: 0, alt: false }], texts: ['notes'] });
    await runSlash('skills', '', first.context);
    const file = path.join(place.home, '.momonga', 'skills', 'notes', 'SKILL.md');
    expect(first.recorded.opened).toEqual([file]);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^---\nname: notes\ndescription: /);
    const again = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project } }, { choices: [{ index: 0, alt: false }], texts: ['notes'] });
    await runSlash('skills', '', again.context);
    expect(again.recorded.opened).toEqual([]);
    expect(again.recorded.infos).toEqual([`${file} exists already; open it from /skills`]);
  });
});

describe('/memory Open AGENTS.md (design-screens 12.1 row 40)', () => {
  it('opens the AGENTS.md of the folder through the external editor', async () => {
    const { context, recorded } = contextOf();
    await runSlash('memory', 'open', context);
    expect(recorded.opened).toEqual([path.join(context.backend.cwd, 'AGENTS.md')]);
    expect(OPEN_AGENTS_FILE_ROW).toBe('Open AGENTS.md');
  });
});
