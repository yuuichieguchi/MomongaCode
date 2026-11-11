export const PAUSE_BUDGET_MICROS = 100_000;

export const MEMORY_MATCH_MICROS_PER_ROW = 2;

export const MEMORY_SCAN_MICROS_PER_ROW = 1.2;

export const MEMORY_LIMIT_STEP = 1_000;

export const MEMORY_MATCH_BUDGET_MICROS = Math.floor(PAUSE_BUDGET_MICROS / 3);

export const MEMORY_SCAN_BUDGET_MICROS = PAUSE_BUDGET_MICROS;

const rowsWithin = (budgetMicros: number, microsPerRow: number): number => Math.floor(budgetMicros / microsPerRow / MEMORY_LIMIT_STEP) * MEMORY_LIMIT_STEP;

export const MEMORY_MATCH_LIMIT = rowsWithin(MEMORY_MATCH_BUDGET_MICROS, MEMORY_MATCH_MICROS_PER_ROW);

export const MEMORY_SCAN_LIMIT = rowsWithin(MEMORY_SCAN_BUDGET_MICROS, MEMORY_SCAN_MICROS_PER_ROW);
