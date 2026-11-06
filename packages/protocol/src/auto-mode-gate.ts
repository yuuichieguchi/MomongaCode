export const AUTO_MODE_EVAL_COMMAND = 'momonga eval packages/eval/datasets/auto-mode.json';

export const autoModeNotMeasuredMessage = (classifier: string | undefined): string =>
  `auto mode is not available${classifier === undefined ? '' : ` for the classifier ${classifier}`}: no passing measurement record matches the classifier, the classifier code and the dataset; run ${AUTO_MODE_EVAL_COMMAND} with the classifier configured`;
