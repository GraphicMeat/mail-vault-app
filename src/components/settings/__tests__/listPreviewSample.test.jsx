// @vitest-environment jsdom

// "3 lines preview is missing a 3 line preview sample": the sample rows are
// the list's rows in miniature, so they clamp to the chosen number of lines
// and lead with the same gutter the real list does.
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { WorkspacePreview } from '../PreferencePreview';
import en from '../../../i18n/locales/en.json';

afterEach(cleanup);

const rows = (container) => [...container.querySelectorAll('.preview-message-row')];

it('clamps the sample message to the chosen number of preview lines', () => {
  for (const lines of [1, 2, 3]) {
    const { container } = render(<WorkspacePreview setting="listPreviewLines" value={lines} label="Preview lines" />);
    const snippets = [...container.querySelectorAll('.preview-message-snippet')];
    expect(snippets).toHaveLength(2);
    for (const snippet of snippets) {
      expect(snippet.textContent).toBe(en['listPreview.sample']);
      expect(snippet.style.webkitLineClamp || snippet.style.WebkitLineClamp).toBe(String(lines));
    }
    cleanup();
  }
});

it('draws no sample message with preview lines off', () => {
  const { container } = render(<WorkspacePreview setting="listPreviewLines" value={0} label="Preview lines" />);
  expect(container.querySelector('.preview-message-snippet')).toBeNull();
});

it('leads every sample row with the list gutter, stacked while the row has two lines', () => {
  const { container } = render(<WorkspacePreview setting="listPreviewLines" value={3} label="Preview lines" />);
  expect(rows(container)).toHaveLength(2);
  for (const row of rows(container)) {
    expect(row.firstElementChild.classList.contains('row-gutter')).toBe(true);
    expect(row.firstElementChild.classList.contains('row-gutter-stacked')).toBe(true);
  }
  cleanup();
  const single = render(<WorkspacePreview setting="emailListStyle" value="default" label="Message rows" />);
  expect(rows(single.container)).toHaveLength(2);
  for (const row of rows(single.container)) {
    expect(row.firstElementChild.classList.contains('row-gutter')).toBe(true);
    expect(row.firstElementChild.classList.contains('row-gutter-stacked')).toBe(false);
  }
});
