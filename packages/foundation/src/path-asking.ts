import type { CanonicalDirectoryResult, PathResolver, SyncPathResolver } from './path-compare.ts';

type PathQuestion =
  | { ask: 'realPath'; target: string }
  | { ask: 'canonicalPath'; target: string }
  | { ask: 'canonicalDirectory'; target: string }
  | { ask: 'comparableContains'; directory: string; candidate: string };

export type PathAsking<Answer> = Generator<PathQuestion, Answer, unknown>;

function* asking<Answer>(question: PathQuestion): PathAsking<Answer> {
  return (yield question) as Answer;
}

export const askedPaths = {
  realPath: (target: string): PathAsking<string> => asking({ ask: 'realPath', target }),
  canonicalPath: (target: string): PathAsking<string> => asking({ ask: 'canonicalPath', target }),
  canonicalDirectory: (target: string): PathAsking<CanonicalDirectoryResult> => asking({ ask: 'canonicalDirectory', target }),
  comparableContains: (directory: string, candidate: string): PathAsking<boolean> => asking({ ask: 'comparableContains', directory, candidate }),
};

const answerOf = (paths: SyncPathResolver | PathResolver, question: PathQuestion): unknown => {
  switch (question.ask) {
    case 'realPath':
      return paths.realPath(question.target);
    case 'canonicalPath':
      return paths.canonicalPath(question.target);
    case 'canonicalDirectory':
      return paths.canonicalDirectory(question.target);
    case 'comparableContains':
      return paths.comparableContains(question.directory, question.candidate);
  }
};

export const answeredNow = <Answer>(work: PathAsking<Answer>, paths: SyncPathResolver): Answer => {
  let turn = work.next();
  while (turn.done !== true) {
    let answer: unknown;
    try {
      answer = answerOf(paths, turn.value);
    } catch (error) {
      turn = work.throw(error);
      continue;
    }
    turn = work.next(answer);
  }
  return turn.value;
};

export const answeredLater = async <Answer>(work: PathAsking<Answer>, paths: PathResolver, signal: AbortSignal): Promise<Answer> => {
  let turn = work.next();
  while (turn.done !== true) {
    let answer: unknown;
    try {
      answer = await answerOf(paths, turn.value);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      turn = work.throw(error);
      continue;
    }
    turn = work.next(answer);
  }
  return turn.value;
};
