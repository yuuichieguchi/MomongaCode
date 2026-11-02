import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputItem, RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

const PDF_BODY = 'Extract the text with scripts/extract.py first.';

const writeSkill = (directory: string, name: string, description: string, body: string, resources: Record<string, string> = {}): string => {
  const skillDirectory = path.join(directory, name);
  fs.mkdirSync(skillDirectory, { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  for (const [relative, text] of Object.entries(resources)) {
    fs.mkdirSync(path.dirname(path.join(skillDirectory, relative)), { recursive: true });
    fs.writeFileSync(path.join(skillDirectory, relative), text);
  }
  return skillDirectory;
};

const projectSkills = (env: Env): string => path.join(env.project, '.agents', 'skills');

const inputOf = (env: Env, index: number): InputItem[] => {
  const body = env.gateway.streams[index]?.body;
  if (body === undefined || !Array.isArray(body.input)) throw new Error(`stream ${index} has no input array`);
  return body.input as InputItem[];
};

const developerTexts = (items: readonly InputItem[]): string[] => items.filter((item) => item.type === 'message' && item.role === 'developer').map(textOf);

const activate = (callId: string, name: string) => callsStep([{ callId, name: 'activate_skill', args: { name } }]);

const responded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

describe('worker skills: catalog', () => {
  it('shows the catalog as a developer item and offers activate_skill with the skill names', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    env.enqueue('Read the pdf');
    env.gateway.script.push(textStep('ok'));

    await env.runOnce(env.worker());

    const catalog = developerTexts(inputOf(env, 0)).find((text) => text.includes('<available_skills>'));
    expect(catalog).toContain('<name>pdf</name>');
    expect(catalog).toContain('<description>Extract PDF text</description>');
    expect(catalog).not.toContain(PDF_BODY);
    const tool = env.gateway.streams[0]?.body.tools?.find((candidate) => candidate.type === 'function' && candidate.name === 'activate_skill');
    expect(tool).toMatchObject({ parameters: { properties: { name: { enum: ['pdf'] } } } });
  });

  it('shows neither a catalog nor the tool without skills', async () => {
    const env = await makeEnv();
    env.enqueue('Say hello');
    env.gateway.script.push(textStep('ok'));

    await env.runOnce(env.worker());

    expect(developerTexts(inputOf(env, 0))).toEqual([]);
    expect(env.gateway.streams[0]?.body.tools?.some((candidate) => candidate.type === 'function' && candidate.name === 'activate_skill')).toBe(false);
  });

  it('skips project skills in an untrusted folder, keeps user skills and records a notice', async () => {
    const env = await makeEnv();
    env.settings.trustedValue = false;
    writeSkill(projectSkills(env), 'project-only', 'From the repository', 'Project body');
    writeSkill(path.join(env.home, '.agents', 'skills'), 'user-only', 'From the user', 'User body');
    const run = env.enqueue('Say hello');
    env.gateway.script.push(textStep('ok'));

    await env.runOnce(env.worker());

    const catalog = developerTexts(inputOf(env, 0)).join('\n');
    expect(catalog).toContain('<name>user-only</name>');
    expect(catalog).not.toContain('project-only');
    expect(env.ofType(run.id, 'notice').map((event) => event.message)).toContain(
      `Project skills in ${path.join(env.project, '.agents', 'skills')} were skipped because the folder is not trusted`,
    );
  });

  it('reports a collision between a project and a user skill once and keeps the project skill', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'review', 'Project review', 'Project body');
    writeSkill(path.join(env.home, '.agents', 'skills'), 'review', 'User review', 'User body');
    const run = env.enqueue('Say hello');
    env.gateway.script.push(textStep('ok'));

    await env.runOnce(env.worker());

    expect(developerTexts(inputOf(env, 0)).join('\n')).toContain('Project review');
    expect(env.ofType(run.id, 'notice').filter((event) => event.message.includes('takes precedence'))).toHaveLength(1);
  });
});

describe('worker skills: activation', () => {
  it('records the activation, protects the body and keeps one copy in the next request', async () => {
    const env = await makeEnv();
    const skillDirectory = writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY, { 'scripts/extract.py': 'print(1)' });
    const run = env.enqueue('Read the pdf');
    env.gateway.script.push(activate('call_skill', 'pdf'), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.output).toContain('<skill_content name="pdf">');
    expect(completed?.output).toContain(PDF_BODY);
    expect(completed?.output).toContain(`Skill directory: ${fs.realpathSync(skillDirectory)}`);
    expect(completed?.output).toContain('<file>scripts/extract.py</file>');
    expect(completed?.output).not.toContain('print(1)');
    const [activated] = env.ofType(run.id, 'skill.activated');
    expect(activated).toMatchObject({ name: 'pdf', content: completed?.output });
    expect(activated?.seq).toBe((completed?.seq ?? 0) + 1);
    expect(env.fold(run.id).activatedSkills).toEqual([{ name: 'pdf', content: completed?.output }]);

    const second = inputOf(env, 1);
    const holders = second.filter((item) => textOf(item).includes(PDF_BODY) || (item.type === 'function_call_output' && String(item.output).includes(PDF_BODY)));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ type: 'message', role: 'developer' });
    expect(textOf(holders[0])).toBe(`Activated skill pdf:\n${completed?.output}`);
    const pointer = second.find((item) => item.type === 'function_call_output');
    expect(pointer).toMatchObject({ output: 'Skill pdf is active. Its instructions are kept in the protected context above.' });
  });

  it('keeps the catalog identical across the steps of a run so that the pinned prefix holds', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    env.enqueue('Read the pdf');
    env.gateway.script.push(activate('call_skill', 'pdf'), textStep('Done.'));

    await env.runOnce(env.worker());

    const catalogs = [0, 1].map((index) => developerTexts(inputOf(env, index)).find((text) => text.includes('<available_skills>')));
    expect(catalogs[0]).toBeDefined();
    expect(catalogs[1]).toBe(catalogs[0]);
  });

  it('does not duplicate a skill that is activated twice', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const run = env.enqueue('Read the pdf');
    env.gateway.script.push(activate('call_one', 'pdf'), activate('call_two', 'pdf'), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'skill.activated')).toHaveLength(1);
    const outputs = env.ofType(run.id, 'tool.completed').map((event) => event.output);
    expect(outputs[0]).toContain('<skill_content name="pdf">');
    expect(outputs[1]).toBe('Skill pdf is already active; its instructions are already in your context.');
    const last = inputOf(env, 2);
    expect(last.filter((item) => textOf(item).includes(PDF_BODY))).toHaveLength(1);
    expect(env.fold(run.id).activatedSkills).toHaveLength(1);
  });

  it('rejects a name that is not in the catalog without activating anything', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const run = env.enqueue('Read the pdf');
    env.gateway.script.push(activate('call_bad', 'invented'), textStep('Done.'));

    await env.runOnce(env.worker());

    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.status).toBe('failed');
    expect(env.ofType(run.id, 'skill.activated')).toEqual([]);
  });

  it('lets the next run of the session start with the skill already active', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    env.enqueue('Read the pdf');
    env.gateway.script.push(activate('call_skill', 'pdf'), textStep('Done.'), textStep('Again.'));
    await env.runOnce(env.worker());

    const second = env.enqueue('And once more');
    await env.runOnce(env.worker());

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.fold(second.id).activatedSkills.map((skill) => skill.name)).toEqual(['pdf']);
    const request = inputOf(env, 2);
    expect(request.filter((item) => textOf(item).includes(PDF_BODY))).toHaveLength(1);
    expect(developerTexts(request).some((text) => text.startsWith('Activated skill pdf:'))).toBe(true);
  });
});

describe('worker skills: explicit activation', () => {
  it('shows the explicitly activated skill to the first model call', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const content = '<skill_content name="pdf">\nexplicit body\n</skill_content>';
    const run = env.enqueue('Use the pdf skill', { skill: { name: 'pdf', content } });
    env.gateway.script.push(textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'skill.activated').map((event) => event.name)).toEqual(['pdf']);
    expect(developerTexts(inputOf(env, 0))).toContain(`Activated skill pdf:\n${content}`);
  });

  it('does not activate it again when the model asks for the same skill', async () => {
    const env = await makeEnv();
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const run = env.enqueue('Use the pdf skill', { skill: { name: 'pdf', content: '<skill_content name="pdf">\nexplicit body\n</skill_content>' } });
    env.gateway.script.push(activate('call_skill', 'pdf'), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'skill.activated')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.completed')[0]?.output).toContain('already active');
  });
});

describe('worker skills: compaction', () => {
  it('keeps an activated skill in the request after the history that carried it was compacted', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const wrapped = '<skill_content name="pdf">\nrecorded body\n</skill_content>';
    const run = env.enqueue('Task one');
    env.seed(
      run.id,
      [
        { type: 'skill.activated', name: 'pdf', content: wrapped },
        responded(1, [assistantMessage('msg_big', 'x'.repeat(100_000))]),
        { type: 'user.message', text: 'question two' },
        responded(2, [assistantMessage('msg_r2', 'answer two')]),
        { type: 'user.message', text: 'question three' },
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.compactSummaries.push('S1');
    env.gateway.script.push(textStep('Answer four.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.gateway.compacts).toHaveLength(1);
    const input = inputOf(env, 0);
    expect(developerTexts(input)).toContain(`Activated skill pdf:\n${wrapped}`);
    expect(input.some((item) => item.type === 'compaction')).toBe(true);
    expect(input.some((item) => textOf(item).includes('x'.repeat(1000)))).toBe(false);
  });

  it('keeps the activation output out of the text sent to the compactor', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    const wrapped = '<skill_content name="pdf">\nrecorded body\n</skill_content>';
    const run = env.enqueue('Task one');
    env.seed(
      run.id,
      [
        responded(1, [{ type: 'function_call', id: 'fc_1', call_id: 'call_skill', name: 'activate_skill', arguments: '{"name":"pdf"}', status: 'completed' }]),
        { type: 'tool.call', callId: 'call_skill', providerCallId: 'call_skill', name: 'activate_skill', kind: 'read', title: 'Activate skill pdf', rawInput: { name: 'pdf' } },
        { type: 'tool.completed', callId: 'call_skill', status: 'completed', output: wrapped },
        { type: 'skill.activated', name: 'pdf', content: wrapped },
        responded(2, [assistantMessage('msg_big', 'x'.repeat(100_000))]),
        { type: 'user.message', text: 'question two' },
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        { type: 'user.message', text: 'question three' },
        responded(4, [assistantMessage('msg_r4', 'answer four')]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.compactSummaries.push('S1');
    env.gateway.script.push(textStep('Answer.'));

    await env.runOnce(env.worker());

    const [compact] = env.gateway.compacts;
    const sent = JSON.stringify(compact?.request.input);
    expect(sent).not.toContain('recorded body');
    expect(sent).toContain('Skill pdf is active');
  });
});

describe('worker skills: reading bundled resources', () => {
  it('hands the real directories of the loaded skills to the executor as read roots', async () => {
    const env = await makeEnv();
    const userSkill = writeSkill(path.join(env.home, '.agents', 'skills'), 'zip', 'Pack files', 'Zip body');
    const projectSkill = writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    env.enqueue('Use tools');
    env.gateway.script.push(callsStep([{ callId: 'call_echo', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.batches).toHaveLength(1);
    expect([...(env.batches[0]?.readRoots ?? [])].sort()).toEqual([fs.realpathSync(projectSkill), fs.realpathSync(userSkill)].sort());
  });

  it('offers no read roots for the skills of an untrusted folder', async () => {
    const env = await makeEnv();
    env.settings.trustedValue = false;
    writeSkill(projectSkills(env), 'pdf', 'Extract PDF text', PDF_BODY);
    env.enqueue('Use tools');
    env.gateway.script.push(callsStep([{ callId: 'call_echo', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.batches[0]?.readRoots).toEqual([]);
  });
});
