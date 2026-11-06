const UNITS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

exports.parseDuration = (text) => {
  const match = /(\d+)(ms|h|m|s)/.exec(text);
  if (match === null) throw new Error(`invalid duration: ${text}`);
  return Number(match[1]) * UNITS[match[2]];
};
