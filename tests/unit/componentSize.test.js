// tests/unit/componentSize.test.js
//
// The three largest React components ran every hook on every state change.
// Their state now lives in custom hooks by concern (src/hooks/app,
// src/hooks/emailList, src/components/compose) and the components are layout
// plus wiring. This pins the size they reached so they cannot grow back into
// one function again: a new concern gets its own hook, not more lines here.
//
// The limits are what the files measured when the split landed, rounded up to
// the next ten. When a file shrinks, LOWER its limit here; never raise one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const LIMITS = {
  'src/App.jsx': 1050,
  'src/components/EmailList.jsx': 1340,
  'src/components/ComposeModal.jsx': 1800,
};

const lineCount = file => readFileSync(file, 'utf8').split('\n').length;

describe('the large components stay split into hooks', () => {
  for (const [file, limit] of Object.entries(LIMITS)) {
    it(`${file} is at most ${limit} lines`, () => {
      expect(lineCount(file), `${file} is over ${limit} lines: give the new concern its own hook; when a file shrinks, lower its limit in LIMITS`).toBeLessThanOrEqual(limit);
    });
  }
});
