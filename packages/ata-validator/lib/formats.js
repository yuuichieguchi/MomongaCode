'use strict';

function isDigit (c) { return c >= 48 && c <= 57; }

function date (s) {
  if (s.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i);
    if (i === 4 || i === 7) { if (c !== 45) return false; } else if (!isDigit(c)) return false;
  }
  const m = (s.charCodeAt(5) - 48) * 10 + (s.charCodeAt(6) - 48);
  const d = (s.charCodeAt(8) - 48) * 10 + (s.charCodeAt(9) - 48);
  if (m < 1 || m > 12 || d < 1) return false;
  const y = (s.charCodeAt(0) - 48) * 1000 + (s.charCodeAt(1) - 48) * 100 +
            (s.charCodeAt(2) - 48) * 10 + (s.charCodeAt(3) - 48);
  return d <= daysInMonth(y, m);
}

function daysInMonth (year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function twoDigits (s, i) {
  return (s.charCodeAt(i) - 48) * 10 + (s.charCodeAt(i + 1) - 48);
}

function dateTime (s) {
  const n = s.length;
  if (n < 20) return false;
  if (s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return false;
  const sep = s.charCodeAt(10);
  if (sep !== 84 && sep !== 116) return false;
  if (s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58) return false;

  const y0 = s.charCodeAt(0) - 48, y1 = s.charCodeAt(1) - 48;
  const y2 = s.charCodeAt(2) - 48, y3 = s.charCodeAt(3) - 48;
  if ((y0 >>> 0) > 9 || (y1 >>> 0) > 9 || (y2 >>> 0) > 9 || (y3 >>> 0) > 9) return false;
  const year = y0 * 1000 + y1 * 100 + y2 * 10 + y3;

  const mo0 = s.charCodeAt(5) - 48, mo1 = s.charCodeAt(6) - 48;
  if ((mo0 >>> 0) > 9 || (mo1 >>> 0) > 9) return false;
  const month = mo0 * 10 + mo1;
  if (month < 1 || month > 12) return false;

  const d0 = s.charCodeAt(8) - 48, d1 = s.charCodeAt(9) - 48;
  if ((d0 >>> 0) > 9 || (d1 >>> 0) > 9) return false;
  const day = d0 * 10 + d1;
  if (day < 1 || day > daysInMonth(year, month)) return false;

  const h0 = s.charCodeAt(11) - 48, h1 = s.charCodeAt(12) - 48;
  if ((h0 >>> 0) > 9 || (h1 >>> 0) > 9 || h0 * 10 + h1 > 23) return false;
  const mi0 = s.charCodeAt(14) - 48, mi1 = s.charCodeAt(15) - 48;
  if ((mi0 >>> 0) > 5 || (mi1 >>> 0) > 9) return false;
  const se0 = s.charCodeAt(17) - 48, se1 = s.charCodeAt(18) - 48;
  if ((se0 >>> 0) > 6 || (se1 >>> 0) > 9 || se0 * 10 + se1 > 60) return false;

  let i = 19;
  if (s.charCodeAt(i) === 46) {
    i++;
    const start = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (i === start) return false;
  }

  const c = s.charCodeAt(i);
  const sec = se0 * 10 + se1;
  const hh = h0 * 10 + h1, mi = mi0 * 10 + mi1;
  let offMin = 0;
  if (c === 90 || c === 122) {
    if (i !== n - 1) return false;
  } else {
    if (c !== 43 && c !== 45) return false;
    if (n - i !== 6) return false;
    if (!isDigit(s.charCodeAt(i + 1)) || !isDigit(s.charCodeAt(i + 2))) return false;
    if (s.charCodeAt(i + 3) !== 58) return false;
    if (!isDigit(s.charCodeAt(i + 4)) || !isDigit(s.charCodeAt(i + 5))) return false;
    const oh = twoDigits(s, i + 1), om = twoDigits(s, i + 4);
    if (oh > 23 || om > 59) return false;
    offMin = (c === 43 ? 1 : -1) * (oh * 60 + om);
  }
  if (sec === 60) {
    const utc = ((hh * 60 + mi - offMin) % 1440 + 1440) % 1440;
    if (utc !== 1439) return false;
  }
  return true;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function ipv4 (s) {
  return IPV4.test(s);
}

function ipv4Range (s, from, to) {
  const n = to - from;
  if (n < 7 || n > 15) return false;
  let octets = 0, value = 0, digits = 0;
  for (let i = from; i <= to; i++) {
    const c = i < to ? s.charCodeAt(i) : 46;
    if (c === 46) {
      if (digits === 0 || value > 255) return false;
      octets++; value = 0; digits = 0;
      if (octets > 4) return false;
    } else if (isDigit(c)) {
      if (digits === 1 && value === 0) return false;
      value = value * 10 + (c - 48); digits++;
      if (digits > 3) return false;
    } else return false;
  }
  return octets === 4;
}

const IPV6_FULL = /^(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}$/;

function ipv6 (s) {
  const n = s.length;
  if (n >= 15 && IPV6_FULL.test(s)) return true;
  if (n < 2 || n > 45) return false;

  let end = n;
  let groups = 0;
  const dot = s.indexOf('.');
  if (dot !== -1) {
    const lastColon = s.lastIndexOf(':', dot);
    if (lastColon === -1) return false;
    if (!ipv4Range(s, lastColon + 1, n)) return false;
    end = lastColon + 1;
    groups = 2;
  }

  let compressed = false;
  let digits = 0;
  let i = 0;

  if (s.charCodeAt(0) === 58 && s.charCodeAt(1) !== 58) return false;

  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 58) {
      if (digits > 0) { groups++; digits = 0; }
      if (i + 1 < n && s.charCodeAt(i + 1) === 58) {
        if (compressed) return false;
        compressed = true;
        i += 2;
        if (i < n && s.charCodeAt(i) === 58) return false;
        continue;
      }
      i++;
      if (i === end && end === n) return false;
      continue;
    }
    if (isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) {
      if (++digits > 4) return false;
      i++;
      continue;
    }
    return false;
  }
  if (digits > 0) groups++;

  if (groups > 8) return false;
  return compressed ? groups < 8 : groups === 8;
}

function hostname (s, from, to) {
  const start = from === undefined ? 0 : from;
  const end = to === undefined ? s.length : to;
  const n = end - start;
  if (n === 0 || n > 253) return false;
  let labelLength = 0;
  let previous = 46;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 46) {
      if (labelLength === 0 || previous === 45) return false;
      labelLength = 0;
      previous = c;
      continue;
    }
    const alnum = isDigit(c) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
    if (!alnum && c !== 45) return false;
    if (c === 45 && previous === 46) return false;
    if (++labelLength > 63) return false;
    previous = c;
  }
  if (labelLength === 0 || previous === 45) return false;
  return require('./idna2008').hostnameLabelsOk(s.slice(start, end));
}

const URI_FAST = /^[A-Za-z][A-Za-z0-9+.\-]*:(?:\/\/[!$&-.0-9;=A-Z_a-z~]*(?::[0-9]*)?(?:[\/?][!$&-;=?-Z_a-z~]*)?|(?!\/\/)[!$&-;=?-Z_a-z~]*)(?:#[!$&-;=?-Z_a-z~]*)?$/;

const _uriWalk = require('./uri-core').__ataUri(ipv6);
function uri (s) { return URI_FAST.test(s) || _uriWalk(s, 1); }
function uriReference (s) { return _uriWalk(s, 0); }
function iri (s) { return URI_FAST.test(s) || _uriWalk(s, 3); }
function iriReference (s) { return _uriWalk(s, 2); }

const NON_PRINTABLE = /[^\u0021-\u007e]/;

function idnEmail (s) {
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.charCodeAt(0) === 34) {
    return local.length >= 2 && local.charCodeAt(local.length - 1) === 34 && domain.length > 0;
  }
  if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46) return false;
  if (local.indexOf('..') !== -1) return false;
  if (domain.charCodeAt(0) === 91) {
    return domain.charCodeAt(domain.length - 1) === 93 && domain.length > 2;
  }
  if (domain.charCodeAt(0) === 46 || domain.charCodeAt(domain.length - 1) === 46) return false;
  if (domain.indexOf('..') !== -1) return false;
  if (domain.charCodeAt(0) === 45 || domain.charCodeAt(domain.length - 1) === 45 || domain.indexOf('-.') !== -1 || domain.indexOf('.-') !== -1) return false;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    if (c <= 32 || c === 127 || c === 64) return false;
  }
  return true;
}

function noReserved (s, from) {
  if (!NON_PRINTABLE.test(s)) return true;
  const n = s.length;
  for (let i = from; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c < 127) continue;
    if (c <= 32 || c === 127) return false;
    if (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
      c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) return false;
  }
  return true;
}

const UUID_CLASS = new Uint8Array(128);
for (let i = 48; i < 58; i++) UUID_CLASS[i] = 1;
for (let i = 97; i < 103; i++) UUID_CLASS[i] = 1;
for (let i = 65; i < 71; i++) UUID_CLASS[i] = 1;
UUID_CLASS[45] = 2;
const UUID_WANT = new Uint8Array(36).fill(1);
UUID_WANT[8] = UUID_WANT[13] = UUID_WANT[18] = UUID_WANT[23] = 2;

function uuid (s) {
  if (s.length !== 36) return false;
  let bad = 0;
  for (let i = 0; i < 36; i++) bad |= UUID_CLASS[s.charCodeAt(i)] ^ UUID_WANT[i];
  return bad === 0;
}

function time (s) {
  const n = s.length;
  if (n < 8) return false;
  const h1 = s.charCodeAt(0) - 48, h2 = s.charCodeAt(1) - 48;
  if ((h1 >>> 0) > 9 || (h2 >>> 0) > 9 || h1 * 10 + h2 > 23) return false;
  if (s.charCodeAt(2) !== 58 || s.charCodeAt(5) !== 58) return false;
  const m1 = s.charCodeAt(3) - 48, m2 = s.charCodeAt(4) - 48;
  if ((m1 >>> 0) > 5 || (m2 >>> 0) > 9) return false;
  const c1 = s.charCodeAt(6) - 48, c2 = s.charCodeAt(7) - 48;
  if ((c1 >>> 0) > 6 || (c2 >>> 0) > 9 || c1 * 10 + c2 > 60) return false;
  let i = 8;
  if (i < n && s.charCodeAt(i) === 46) {
    i++;
    const start = i;
    while (i < n) {
      const c = s.charCodeAt(i) - 48;
      if ((c >>> 0) > 9) break;
      i++;
    }
    if (i === start) return false;
  }
  if (i === n) return false;
  const hh = h1 * 10 + h2, mm = m1 * 10 + m2, ss = c1 * 10 + c2;
  const z = s.charCodeAt(i);
  let offMin = 0;
  if (z === 90 || z === 122) {
    if (i !== n - 1) return false;
  } else {
    if (z !== 43 && z !== 45) return false;
    if (n - i !== 6 || s.charCodeAt(i + 3) !== 58) return false;
    for (let k = 1; k <= 5; k++) {
      if (k === 3) continue;
      if ((s.charCodeAt(i + k) - 48 >>> 0) > 9) return false;
    }
    const oh = (s.charCodeAt(i + 1) - 48) * 10 + (s.charCodeAt(i + 2) - 48);
    const om = (s.charCodeAt(i + 4) - 48) * 10 + (s.charCodeAt(i + 5) - 48);
    if (oh > 23 || om > 59) return false;
    offMin = (z === 43 ? 1 : -1) * (oh * 60 + om);
  }
  if (ss === 60) {
    const utc = ((hh * 60 + mm - offMin) % 1440 + 1440) % 1440;
    if (utc !== 23 * 60 + 59) return false;
  }
  return true;
}

function jsonPointer(s) {
  if (s === '') return true;
  if (s.charCodeAt(0) !== 47) return false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 126) continue;
    const n = s.charCodeAt(i + 1);
    if (n !== 48 && n !== 49) return false;
  }
  return true;
}

function relativeJsonPointer(s) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return false;
  if (i > 1 && s.charCodeAt(0) === 48) return false;
  const rest = s.slice(i);
  if (rest === '#') return true;
  return jsonPointer(rest);
}

const URI_TEMPLATE_EXPR = /^(?:[+#./;?&=,!@|]?)(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*(?::[1-9][0-9]{0,3}|\*)?)*$/;
function isHexCode (c) { return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70); }
function uriTemplate(s) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 125) return false;
    if (c !== 123 && (c <= 32 || c === 127)) return false;
    if (c === 37) {
      const h1 = s.charCodeAt(i + 1), h2 = s.charCodeAt(i + 2);
      if (!(h1 <= 127) || !(h2 <= 127) || !isHexCode(h1) || !isHexCode(h2)) return false;
      i += 3; continue;
    }
    if (c !== 123) { i++; continue; }
    const end = s.indexOf('}', i + 1);
    if (end === -1) return false;
    const expr = s.slice(i + 1, end);
    if (expr === '' || expr.indexOf('{') !== -1) return false;
    if (!URI_TEMPLATE_EXPR.test(expr)) return false;
    i = end + 1;
  }
  return true;
}
const EMAIL_LOCAL = new Uint8Array(128);
for (let i = 48; i <= 57; i++) EMAIL_LOCAL[i] = 1;
for (let i = 97; i <= 122; i++) EMAIL_LOCAL[i] = 1;
for (let i = 65; i <= 90; i++) EMAIL_LOCAL[i] = 1;
for (let i = 35; i <= 39; i++) EMAIL_LOCAL[i] = 1;
for (let i = 94; i <= 96; i++) EMAIL_LOCAL[i] = 1;
for (let i = 123; i <= 126; i++) EMAIL_LOCAL[i] = 1;
for (const c of [46, 33, 42, 43, 45, 47, 61, 63]) EMAIL_LOCAL[c] = 1;

function email(s) {
  const n = s.length;
  if (n < 3) return false;
  let at;
  if (s.charCodeAt(0) === 34) {
    at = s.lastIndexOf('@');
    if (at < 2 || at === n - 1 || at > 64) return false;
    if (s.charCodeAt(at - 1) !== 34) return false;
    for (let i = 1; i < at - 1; i++) {
      const c = s.charCodeAt(i);
      if (c === 92) { const q = s.charCodeAt(i + 1); if (q < 32 || q > 126 || i + 1 >= at - 1) return false; i++; continue; }
      if (c < 32 || c > 126 || c === 34) return false;
    }
  } else {
    if (s.charCodeAt(0) === 46) return false;
    at = -1;
    let afterDot = false;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c === 64) { at = i; break; }
      if (c > 127 || EMAIL_LOCAL[c] === 0) return false;
      if (c === 46) {
        if (afterDot) return false;
        afterDot = true;
      } else {
        afterDot = false;
      }
    }
    if (at <= 0 || at === n - 1 || at > 64) return false;
    if (s.charCodeAt(at - 1) === 46) return false;
  }
  if (s.charCodeAt(at + 1) === 91) {
    if (s.charCodeAt(n - 1) !== 93 || n - at - 1 <= 2) return false;
    if ((s.charCodeAt(at + 2) | 32) === 105 && (s.charCodeAt(at + 3) | 32) === 112 && (s.charCodeAt(at + 4) | 32) === 118 && s.charCodeAt(at + 5) === 54 && s.charCodeAt(at + 6) === 58) return ipv6(s.slice(at + 7, n - 1));
    return ipv4(s.slice(at + 2, n - 1));
  }
  return hostname(s, at + 1, n);
}

const DURATION_RE = /^P(?:\d+W|(?:\d+Y(?:\d+M(?:\d+D)?)?|\d+M(?:\d+D)?|\d+D)(?:T(?:\d+H(?:\d+M(?:\d+S)?)?|\d+M(?:\d+S)?|\d+S))?|T(?:\d+H(?:\d+M(?:\d+S)?)?|\d+M(?:\d+S)?|\d+S))$/;
function duration (s) { return DURATION_RE.test(s); }

let _checks = null;
function formatChecks () {
  return _checks || (_checks = {
    email,
    date,
    'date-time': dateTime,
    time,
    duration,
    uuid,
    uri,
    'uri-reference': uriReference,
    ipv4,
    ipv6,
    hostname,
    'idn-hostname': (s) => require('./idna2008').idnHostname(s),
    regex: (s) => { try { new RegExp(s, 'u'); return true; } catch { return false; } },
    'json-pointer': jsonPointer,
    'relative-json-pointer': relativeJsonPointer,
    'uri-template': uriTemplate,
    iri,
    'iri-reference': iriReference,
    'idn-email': idnEmail,
  });
}

module.exports = { formatChecks, IPV4, DURATION_RE, IPV6_FULL, ipv4Range, URI_FAST, date, ipv4, dateTime, ipv6, hostname, uri, uriReference, uriWalk: _uriWalk, uuid, time, noReserved, jsonPointer, relativeJsonPointer, uriTemplate, email, duration, iri, iriReference, idnEmail, DURATION_RE, URI_TEMPLATE_EXPR };
