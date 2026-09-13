// @vitest-environment jsdom
//
// ChunkErrorBoundary catches every error under its overlay, not only a chunk
// that failed to load. Compose throwing at runtime showed "Part of the app
// failed to load from disk ... an update replaced the app", which sends people
// to reload for a reason that is not true.

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { ChunkErrorBoundary } from '../ChunkErrorBoundary';

function Throws({ error }) {
  throw error;
}

function openWith(error) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<ChunkErrorBoundary name="Compose"><Throws error={error} /></ChunkErrorBoundary>);
  return screen.getByRole('alertdialog').textContent;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChunkErrorBoundary', () => {
  it.each([
    ['WebKit', new TypeError('Importing a module script failed.')],
    ['WebView2', new TypeError('Failed to fetch dynamically imported module: tauri://localhost/assets/ComposeModal-a1.js')],
    ['a stylesheet', new Error('Unable to preload CSS for /assets/SettingsPage-b2.css')],
  ])('blames the files on disk when %s could not load', (_what, error) => {
    expect(openWith(error)).toContain('failed to load from disk');
  });

  it('does not blame an update for an error the overlay threw itself', () => {
    const text = openWith(new TypeError("null is not an object (evaluating 'e.cached')"));
    expect(text).toContain('Compose could not open');
    expect(text).toContain('Something went wrong');
    expect(text).not.toContain('failed to load from disk');
  });
});
