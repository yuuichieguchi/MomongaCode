import type { CallOutputFit } from './types.ts';

const FIRST_BUDGET_CHARS = 1024;

export const pageToFit = async (outputFit: CallOutputFit, render: (budgetChars: number) => string): Promise<string> => {
  let fitting = 0;
  let budget = FIRST_BUDGET_CHARS;
  let rendered = render(budget);
  while (await outputFit.fits(rendered)) {
    const larger = render(budget * 2);
    if (larger === rendered) return rendered;
    fitting = budget;
    budget *= 2;
    rendered = larger;
  }
  let low = fitting;
  let high = budget;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await outputFit.fits(render(middle))) low = middle;
    else high = middle;
  }
  return render(low);
};
