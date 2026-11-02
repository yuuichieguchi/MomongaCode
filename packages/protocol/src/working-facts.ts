import { WORKING_FACTS_KEPT, WORKING_FACT_TEXT_CHARS } from './budget-constants.ts';

export const FILE_ACCESSES = ['read', 'write'] as const;

export type FileAccess = (typeof FILE_ACCESSES)[number];

export type ToolFile = { path: string; sha256: string; access: FileAccess };

export type PlanEntryRecord = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' };

export type ReconciledOutcome = 'already_applied' | 'unknown';

export type WrittenFact = { path: string; sha256?: string; reconciled?: ReconciledOutcome; seq: number };

export type CommandFact = { command: string; failed: boolean; exitCode?: number; reconciled?: ReconciledOutcome; seq: number };

export type MessageFact = { text: string; seq: number };

export type ItemEvent = { itemSeq: number; eventSeq: number };

export type WorkingFacts = {
  written: WrittenFact[];
  commands: CommandFact[];
  messages: MessageFact[];
  taskText?: string;
  plan?: { seq: number; entries: PlanEntryRecord[] };
  itemEvents: ItemEvent[];
  replacedThroughEventSeq?: number;
};

export const INHERITED_FACT_SEQ = 0;

export const emptyWorkingFacts = (): WorkingFacts => ({ written: [], commands: [], messages: [], itemEvents: [] });

const newest = <T>(entries: readonly T[]): T[] => entries.slice(-WORKING_FACTS_KEPT);

export const boundedFactText = (text: string): string => text.slice(0, WORKING_FACT_TEXT_CHARS);

const keptCommands = (commands: CommandFact[]): CommandFact[] => {
  const kept = [...commands];
  while (kept.length > WORKING_FACTS_KEPT) {
    const resolved = kept.findIndex((fact) => !fact.failed);
    kept.splice(resolved < 0 ? 0 : resolved, 1);
  }
  return kept;
};

export const withWritten = (facts: WorkingFacts, fact: WrittenFact): WorkingFacts => {
  const path = boundedFactText(fact.path);
  return { ...facts, written: newest([...facts.written.filter((entry) => entry.path !== path), { ...fact, path }]) };
};

export const withCommand = (facts: WorkingFacts, fact: CommandFact): WorkingFacts => {
  const command = boundedFactText(fact.command);
  return { ...facts, commands: keptCommands([...facts.commands.filter((entry) => entry.command !== command), { ...fact, command }]) };
};

export const withMessage = (facts: WorkingFacts, fact: MessageFact): WorkingFacts => ({
  ...facts,
  messages: newest([...facts.messages, { ...fact, text: boundedFactText(fact.text) }]),
});

export const withTaskText = (facts: WorkingFacts, text: string): WorkingFacts => ({ ...facts, taskText: boundedFactText(text) });

export const withItemEvents = (facts: WorkingFacts, itemSeqs: readonly number[], eventSeq: number): WorkingFacts => ({
  ...facts,
  itemEvents: [...facts.itemEvents, ...itemSeqs.map((itemSeq): ItemEvent => ({ itemSeq, eventSeq }))],
});

export const withReplacedThrough = (facts: WorkingFacts, replacedThroughItemSeq: number): WorkingFacts => {
  const own = facts.itemEvents.find((entry) => entry.itemSeq === replacedThroughItemSeq);
  const replacedThroughEventSeq = own === undefined ? facts.replacedThroughEventSeq : Math.max(own.eventSeq, facts.replacedThroughEventSeq ?? 0);
  return {
    ...facts,
    itemEvents: facts.itemEvents.filter((entry) => entry.itemSeq > replacedThroughItemSeq),
    ...(replacedThroughEventSeq === undefined ? {} : { replacedThroughEventSeq }),
  };
};

export const inheritedWorkingFacts = (facts: WorkingFacts, carryTask: boolean): WorkingFacts => ({
  written: facts.written.map((entry) => ({ ...entry, seq: INHERITED_FACT_SEQ })),
  commands: facts.commands.map((entry) => ({ ...entry, seq: INHERITED_FACT_SEQ })),
  messages: [
    ...(carryTask && facts.taskText !== undefined ? [{ text: facts.taskText, seq: INHERITED_FACT_SEQ }] : []),
    ...facts.messages.map((entry) => ({ ...entry, seq: INHERITED_FACT_SEQ })),
  ],
  ...(facts.plan === undefined ? {} : { plan: { ...facts.plan, seq: INHERITED_FACT_SEQ } }),
  itemEvents: [],
});
