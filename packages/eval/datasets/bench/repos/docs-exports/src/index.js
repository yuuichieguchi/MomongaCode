exports.upper = (text) => text.toUpperCase();
exports.reverse = (text) => [...text].reverse().join("");
exports.words = (text) => text.split(/\s+/).filter(Boolean);
exports.initials = (text) => exports.words(text).map((word) => word[0]).join("");
