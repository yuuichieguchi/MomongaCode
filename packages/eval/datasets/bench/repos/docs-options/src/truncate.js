const DEFAULTS = { maxLength: 80, ellipsis: "…", wordBoundary: false };

exports.DEFAULTS = DEFAULTS;

exports.truncate = (text, options = {}) => {
  const { maxLength, ellipsis, wordBoundary } = { ...DEFAULTS, ...options };
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - ellipsis.length);
  return (wordBoundary ? cut.replace(/\s+\S*$/, "") : cut) + ellipsis;
};
