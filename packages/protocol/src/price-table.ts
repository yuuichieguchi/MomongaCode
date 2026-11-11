export type PriceRow = {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMTok: number;
  cachedInputPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
  outputPerMTok: number;
  currency: string;
};

export type PriceField = 'effectiveFrom' | 'inputPerMTok' | 'cachedInputPerMTok' | 'cacheWritePerMTok' | 'outputPerMTok' | 'currency';

export type PriceTableProblem = { index: number; identity: string; field?: PriceField; reason: string };

export const PRICE_DECIMAL_PLACES = 9;

export const PRICE_CURRENCY = 'USD';

const PRICE_SCALE = 10 ** PRICE_DECIMAL_PLACES;
const ROUNDING_NOISE = 1e-3;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRICE_FIELDS = ['inputPerMTok', 'outputPerMTok', 'cachedInputPerMTok', 'cacheWritePerMTok'] as const satisfies readonly PriceField[];

export const priceRowIdentity = (row: Pick<PriceRow, 'provider' | 'model' | 'effectiveFrom'>): string => `${row.provider}/${row.model}@${row.effectiveFrom}`;

export const priceEffectiveFromMs = (row: Pick<PriceRow, 'effectiveFrom'>): number => Date.parse(`${row.effectiveFrom}T00:00:00Z`);

const isCalendarDate = (text: string): boolean => {
  if (!DATE_PATTERN.test(text)) return false;
  const ms = priceEffectiveFromMs({ effectiveFrom: text });
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, text.length) === text;
};

const priceReason = (field: PriceField, price: number): string | undefined => {
  if (!Number.isFinite(price) || price < 0) return `${field} must be a non-negative finite number, got ${price}`;
  if (Math.abs(Math.round(price * PRICE_SCALE) - price * PRICE_SCALE) > ROUNDING_NOISE) return `${field} has more than ${PRICE_DECIMAL_PLACES} decimal places, got ${price}`;
  return undefined;
};

const rowProblem = (row: PriceRow, seen: ReadonlySet<string>): { field?: PriceField; reason: string } | undefined => {
  if (row.currency !== PRICE_CURRENCY) return { field: 'currency', reason: `currency must be ${PRICE_CURRENCY}, got ${row.currency}` };
  if (!isCalendarDate(row.effectiveFrom)) return { field: 'effectiveFrom', reason: 'effectiveFrom must be a calendar date written YYYY-MM-DD' };
  if (seen.has(priceRowIdentity(row))) return { reason: 'the same provider, model and effectiveFrom are listed twice' };
  for (const field of PRICE_FIELDS) {
    const price = row[field];
    if (price === undefined) continue;
    const reason = priceReason(field, price);
    if (reason !== undefined) return { field, reason };
  }
  return undefined;
};

export const priceTableProblem = (rows: readonly PriceRow[]): PriceTableProblem | undefined => {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const identity = priceRowIdentity(row);
    const problem = rowProblem(row, seen);
    if (problem !== undefined) return { index, identity, ...problem };
    seen.add(identity);
  }
  return undefined;
};

export const validatePriceTable = (rows: readonly PriceRow[]): void => {
  const problem = priceTableProblem(rows);
  if (problem !== undefined) throw new RangeError(`price entry ${problem.identity}: ${problem.reason}`);
};
