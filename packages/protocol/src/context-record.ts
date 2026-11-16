export const SUMMARY_SOURCES = ['model', 'deterministic'] as const;

export type SummarySource = (typeof SUMMARY_SOURCES)[number];

export const SUMMARY_SECTION_COVERAGES = ['complete', 'partial', 'none'] as const;

export type SummarySectionCoverage = (typeof SUMMARY_SECTION_COVERAGES)[number];

export type SummaryFidelity = {
  fabricated: string[];
  identifiers: number;
  retained: number;
  sections: SummarySectionCoverage;
};

export const CONTEXT_CHARGE_PURPOSES = ['guideline'] as const;

export type ContextChargePurpose = (typeof CONTEXT_CHARGE_PURPOSES)[number];

export const CHARGE_VIEW_PURPOSES = ['reflection', ...CONTEXT_CHARGE_PURPOSES] as const;

export type ChargeViewPurpose = (typeof CHARGE_VIEW_PURPOSES)[number];

export const CONTRIBUTION_KINDS = ['memory', 'governing', 'summary', 'working_state'] as const;

export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];
