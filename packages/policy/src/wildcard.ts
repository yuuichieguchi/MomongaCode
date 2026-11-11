export const wildcardMatches = (pattern: string, text: string): boolean => {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;
  while (textIndex < text.length) {
    if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      resumeIndex = textIndex;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
    } else if (starIndex >= 0) {
      resumeIndex += 1;
      textIndex = resumeIndex;
      patternIndex = starIndex + 1;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
};
