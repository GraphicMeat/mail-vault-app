import React from 'react';
import { useT } from './index.js';

const SLOT = /<(\d)>([\s\S]*?)<\/\1>/g;

/**
 * A translated string with inline markup: "Read the <0>privacy policy</0> first".
 * Slot N is handed to parts[N], which wraps it in whatever element it needs.
 * Splitting the sentence into separate keys instead would fix English word
 * order into every language — the exact thing that breaks in JA/KO/ZH.
 */
export function T({ k, vars, parts = [] }) {
  const tr = useT();
  const s = tr(k, vars);

  const out = [];
  let last = 0;
  SLOT.lastIndex = 0;
  for (let m = SLOT.exec(s); m; m = SLOT.exec(s)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const part = parts[Number(m[1])];
    out.push(part ? part(m[2]) : m[2]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));

  return <>{out.map((node, i) => <React.Fragment key={i}>{node}</React.Fragment>)}</>;
}
