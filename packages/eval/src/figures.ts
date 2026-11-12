export const FIGURE_DATASET_FORMATS = ['benchmark', 'context', 'golden', 'yield'] as const;

export type ProducibleFigure = {
  readonly figure: string;
  readonly command: readonly string[];
  readonly options: readonly string[];
  readonly dataset: string;
  readonly datasetFormat: (typeof FIGURE_DATASET_FORMATS)[number];
  readonly printedBy: string;
};

const BENCH = { command: ['eval', 'bench'], dataset: 'datasets/bench/benchmark.json', datasetFormat: 'benchmark' } as const;
const CONTEXT = { command: ['eval', 'context'], options: ['--report', '--settings'], dataset: 'datasets/context.json', datasetFormat: 'context', printedBy: 'eval/src/context-report.ts' } as const;
const ECONOMY = { command: ['eval', 'compare'], options: ['--gate'], dataset: 'datasets/economy.json', datasetFormat: 'context' } as const;

export const PRODUCIBLE_FIGURES: readonly ProducibleFigure[] = [
  { ...BENCH, figure: 'Task Completion Rate', options: ['--model', '--report'], printedBy: 'reliability/src/report.ts' },
  { ...BENCH, figure: 'Human Intervention Rate', options: ['--model', '--report'], printedBy: 'reliability/src/report.ts' },
  { ...BENCH, figure: 'Time per Successful Task', options: ['--model', '--report'], printedBy: 'reliability/src/report.ts' },
  { ...BENCH, figure: 'Cost per Successful Task', options: ['--model', '--report'], printedBy: 'reliability/src/cost.ts' },
  { ...BENCH, figure: 'Completion gate against the oracle', options: ['--model', '--report'], printedBy: 'reliability/src/report.ts' },
  { ...BENCH, figure: 'grouped by', options: ['--model', '--group-by'], printedBy: 'reliability/src/report.ts' },
  { ...CONTEXT, figure: 'lossSignalsPerCompaction' },
  { ...CONTEXT, figure: 'continuationRate' },
  { ...ECONOMY, figure: 'costPerSuccess', printedBy: 'eval/src/context-compare.ts' },
  { ...ECONOMY, figure: 'uncachedInputPerSuccess', printedBy: 'eval/src/context-compare.ts' },
  { figure: 'reflection yield', command: ['eval', 'yield'], options: ['--report'], dataset: 'datasets/yield.json', datasetFormat: 'yield', printedBy: 'eval/src/yield-report.ts' },
  { figure: 'false-allow rate', command: ['eval'], options: [], dataset: 'datasets/mandate.json', datasetFormat: 'golden', printedBy: 'eval/src/report.ts' },
];
