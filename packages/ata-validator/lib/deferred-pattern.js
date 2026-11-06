'use strict';

let session = null;

const keyOf = (flags, source, input) => JSON.stringify([flags, source, input]);

function deferredPattern(source) {
  let flags = 'u';
  try { new RegExp(source, flags); } catch { new RegExp(source); flags = ''; }
  return {
    source,
    flags,
    __ataDeferred: true,
    test(input) {
      if (session === null) {
        throw new Error('the pattern ' + JSON.stringify(source) + ' is matched off the calling thread, so it is checked only through evaluateWithPatternAnswers');
      }
      const key = keyOf(flags, source, input);
      const answer = session.answers.get(key);
      if (answer !== undefined) return answer;
      if (!session.asked.has(key)) {
        session.asked.add(key);
        session.queries.push({ source, flags, input });
      }
      return true;
    },
  };
}

function evaluateWithPatternAnswers(answers, run) {
  if (session !== null) throw new Error('pattern answers are already in use');
  const queries = [];
  session = { answers, asked: new Set(), queries };
  try {
    const value = run();
    return { value, queries };
  } finally {
    session = null;
  }
}

module.exports = { deferredPattern, evaluateWithPatternAnswers, patternQueryKey: (query) => keyOf(query.flags, query.source, query.input) };
