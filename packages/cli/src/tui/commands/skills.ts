import { isValidSkillName } from '@momonga/runtime';
import type { SkillView } from '@momonga/protocol';
import type { TemplateKind } from '../file-templates.ts';
import { SkillInvocationError, skillTask } from '../../run/skill-invocation.ts';
import type { SkillInvocation } from '../../run/skill-invocation.ts';
import type { SlashCommand, SlashContext } from '../slash.ts';

export type SkillCommands = { commands: SlashCommand[]; shadowed: string[] };

export const skillCommands = (skills: readonly SkillView[], taken: ReadonlySet<string>): SkillCommands => {
  const commands: SlashCommand[] = [];
  const shadowed: string[] = [];
  for (const skill of skills) {
    if (taken.has(skill.name)) {
      shadowed.push(skill.name);
      continue;
    }
    commands.push({
      name: skill.name,
      usage: '<task>',
      description: skill.description,
      run: async (args, context) => {
        let invocation: SkillInvocation;
        try {
          invocation = skillTask(skill.name, args);
        } catch (error) {
          if (!(error instanceof SkillInvocationError)) throw error;
          context.info(error.message);
          return;
        }
        await context.startRun(invocation.input, { skill: skill.name });
      },
    });
  }
  return { commands, shadowed };
};

export const SKILLS_TITLE = 'Skills';
export const CREATE_FROM_TEMPLATE_ROW = 'Create from a template';
export const OPEN_IN_EDITOR_ROW = 'Open in $EDITOR';
export const TEMPLATE_NAME_TITLE = 'Name (lowercase letters, digits and single hyphens)';

export type ListedFile = { name: string; scope: string; location: string };

export const editorUnsetText = (file: string): string => `Set $VISUAL or $EDITOR to open ${file} from here.`;

export const openInEditor = async (context: SlashContext, file: string): Promise<void> => {
  if ((await context.externalEditor.open(file)).kind === 'unset') context.info(editorUnsetText(file));
};

export const existsAlreadyText = (file: string, command: string): string => `${file} exists already; open it from /${command}`;

const namedProblem = (text: string): string | undefined => (isValidSkillName(text) ? undefined : `invalid name ${JSON.stringify(text)}`);

const createFile = async (context: SlashContext, kind: TemplateKind, command: string): Promise<void> => {
  const name = await context.overlays.promptText({ title: TEMPLATE_NAME_TITLE, validate: namedProblem });
  if (name === undefined) return;
  const created = await context.backend.createFromTemplate(kind, name);
  if (created.kind === 'exists') {
    context.info(existsAlreadyText(created.file, command));
    return;
  }
  await openInEditor(context, created.file);
};

const openFile = async (context: SlashContext, file: ListedFile): Promise<void> => {
  const choice = await context.overlays.choose({ title: file.name, lines: [file.location], rows: [{ label: OPEN_IN_EDITOR_ROW }], decideOn: 'enter', escape: 'back', filter: false });
  if (choice === undefined) return;
  await openInEditor(context, file.location);
};

export const listTemplateFiles = async (context: SlashContext, spec: { title: string; kind: TemplateKind; command: string; files: readonly ListedFile[]; warnings: readonly string[] }): Promise<void> => {
  const choice = await context.overlays.choose({
    title: spec.title,
    lines: [...spec.warnings],
    rows: [...spec.files.map((file) => ({ label: `${file.name}  ${file.scope}  ${file.location}` })), { label: CREATE_FROM_TEMPLATE_ROW }],
    decideOn: 'enter',
    escape: 'back',
    filter: false,
  });
  if (choice === undefined) return;
  const file = spec.files[choice.index];
  if (file === undefined) await createFile(context, spec.kind, spec.command);
  else await openFile(context, file);
};

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'list the skill files, open one in $EDITOR, or create one from a template',
  run: async (_args, context) => {
    const { skills, warnings } = await context.backend.skills();
    await listTemplateFiles(context, { title: SKILLS_TITLE, kind: 'skill', command: 'skills', files: skills, warnings });
  },
};
