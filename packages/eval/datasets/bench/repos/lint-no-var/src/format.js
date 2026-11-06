exports.label = (name, count) => {
  var suffix = count === 1 ? "" : "s";
  var text = name + suffix;
  return text;
};
