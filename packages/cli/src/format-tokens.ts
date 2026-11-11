const THOUSAND = 1000;
const WHOLE_THOUSANDS = /\.0$/;

export const formatTokens = (count: number): string => (count >= THOUSAND ? `${(count / THOUSAND).toFixed(1).replace(WHOLE_THOUSANDS, '')}k` : String(count));
