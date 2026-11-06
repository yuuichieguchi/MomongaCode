const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

exports.parseDuration = (text) => {
  if (!/^(\d+(ms|h|m|s))+$/.test(text)) throw new Error(`invalid duration: ${text}`);
  const seen = new Set();
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|h|m|s)/g)) {
    if (seen.has(unit)) throw new Error(`invalid duration: ${text}`);
    seen.add(unit);
    total += Number(amount) * UNITS[unit];
  }
  return total;
};
