exports.countBy = (items, keyOf) => {
  const counts = {};
  for (const item of items) {
    counts[keyOf(item)] = (counts[keyOf(item)] || 0) + 1;
  }
  return counts;
};
