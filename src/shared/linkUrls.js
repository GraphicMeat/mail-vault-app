// Pure helpers both readers use to cut a web address out of prose. Desktop (utils/linkify.js) and
// mobile (mobile/mailFrame.js) import this; nothing else lives here.

const TRAILING = /[.,;:!?'"]$/;
const PAIRS = { ')': '(', ']': '[', '}': '{' };
const START = /^(?:https?:\/\/|www\.)/i;

const count = (s, ch) => s.split(ch).length - 1;

/// A match with the sentence it sits in trimmed off: `see https://x.com/a.`
/// ends at `a`, and `(https://x.com/a)` keeps no `)` it did not open.
export function trimUrl(url) {
  for (;;) {
    const last = url.at(-1);
    if (TRAILING.test(last)) url = url.slice(0, -1);
    else if (PAIRS[last] && count(url, last) > count(url, PAIRS[last])) url = url.slice(0, -1);
    else return url;
  }
}

/// `www.` alone, or a match that was all punctuation, is not an address.
export const hasAddressBody = (url) => /[a-z0-9]/i.test(url.replace(START, ''));

/// `www.x.com` gets a scheme; an `http(s)://` start is returned as is.
export const hrefForUrl = (url) => (/^www\./i.test(url) ? `https://${url}` : url);

export const isUrlStart = (s) => START.test(s);
