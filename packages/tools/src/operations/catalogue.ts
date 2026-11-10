import gitBranch from './specs/git-branch.json' with { type: 'json' };
import gitCommit from './specs/git-commit.json' with { type: 'json' };
import gitPush from './specs/git-push.json' with { type: 'json' };
import pullRequestComment from './specs/pull-request-comment.json' with { type: 'json' };
import pullRequestCreate from './specs/pull-request-create.json' with { type: 'json' };
import pullRequestMerge from './specs/pull-request-merge.json' with { type: 'json' };
import pullRequestStatus from './specs/pull-request-status.json' with { type: 'json' };
import { parseOperationSpec } from './spec.ts';
import type { OperationSpec } from './spec.ts';

const SPEC_DATA: readonly unknown[] = [gitBranch, gitCommit, gitPush, pullRequestComment, pullRequestCreate, pullRequestMerge, pullRequestStatus];

export const OPERATION_SPECS: readonly OperationSpec[] = SPEC_DATA.map(parseOperationSpec);
