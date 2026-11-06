exports.clamp = (value, min, max) => {
  if (min > max) throw new RangeError('min is above max');
  return Math.min(max, Math.max(min, value));
};
