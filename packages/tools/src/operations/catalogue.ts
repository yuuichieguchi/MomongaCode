import gitBranch from './specs/git-branch.json' with { type: 'json' };
import gitCommit from './specs/git-commit.json' with { type: 'json' };
import gitFetch from './specs/git-fetch.json' with { type: 'json' };
import gitPush from './specs/git-push.json' with { type: 'json' };
import gitStage from './specs/git-stage.json' with { type: 'json' };
import gitUpdate from './specs/git-update.json' with { type: 'json' };
import issueComment from './specs/issue-comment.json' with { type: 'json' };
import issueRead from './specs/issue-read.json' with { type: 'json' };
import pullRequestComment from './specs/pull-request-comment.json' with { type: 'json' };
import pullRequestComments from './specs/pull-request-comments.json' with { type: 'json' };
import pullRequestCreate from './specs/pull-request-create.json' with { type: 'json' };
import pullRequestMerge from './specs/pull-request-merge.json' with { type: 'json' };
import pullRequestStatus from './specs/pull-request-status.json' with { type: 'json' };
import { defineProductSchema } from '@momonga/foundation';
import type { CoveredProgram } from '@momonga/policy';
import programs from './programs.json' with { type: 'json' };
import { OperationSpecError, parseOperationSpec, replacedForms } from './spec.ts';
import type { SupersededForm } from './spec.ts';
import type { OperationSpec } from './spec.ts';

const SPEC_DATA: readonly unknown[] = [gitBranch, gitStage, gitCommit, gitFetch, gitUpdate, gitPush, pullRequestComment, pullRequestCreate, pullRequestMerge, pullRequestStatus, pullRequestComments, issueRead, issueComment];

const PROGRAM_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items: {
    type: 'object',
    properties: {
      program: { type: 'string', minLength: 1 },
      flagOptions: { type: 'array', items: { type: 'string', minLength: 1 } },
      valueOptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    required: ['program', 'flagOptions', 'valueOptions'],
    additionalProperties: false,
  },
} as const;

const validatePrograms = defineProductSchema<CoveredProgram[]>('tools/operation-programs', PROGRAM_SCHEMA);

const parsePrograms = (value: unknown): readonly CoveredProgram[] => {
  const verdict = validatePrograms(value);
  if (!verdict.valid) throw new OperationSpecError(`invalid covered programs: ${verdict.errors[0]?.message ?? 'schema violation'}`);
  return verdict.value;
};

export const COVERED_PROGRAMS: readonly CoveredProgram[] = parsePrograms(programs);

export const OPERATION_SPECS: readonly OperationSpec[] = SPEC_DATA.map(parseOperationSpec);

export type OperationCatalogueFacts = { supersededForms: SupersededForm[]; alwaysOperations: string[] };

export const operationCatalogueFacts = (): OperationCatalogueFacts => ({
  supersededForms: replacedForms(OPERATION_SPECS),
  alwaysOperations: OPERATION_SPECS.filter((spec) => spec.approval === 'always').map((spec) => spec.name),
});
