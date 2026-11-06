exports.label = (name, count) => {
  const suffix = count === 1 ? "" : "s";
  const text = name + suffix;
  return text;
};
