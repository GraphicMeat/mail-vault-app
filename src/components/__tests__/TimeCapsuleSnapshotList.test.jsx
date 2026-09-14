// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SnapshotList } from '../TimeCapsule';
import en from '../../i18n/locales/en.json';

// Fix 0.8 round 1 (I1): a pre-response daemon_rpc failure now carries the
// literal catalog key `errors.daemonUnavailable` as its message. Every
// consumer that stores `e.message` and renders it raw (snapshotStore ->
// TimeCapsule's SnapshotList is one of them) must run it through `tErr`
// before painting it, or the user sees the bare key instead of English.
describe('SnapshotList error banner', () => {
  afterEach(cleanup);

  const noop = () => {};

  it('translates the errors.daemonUnavailable marker instead of showing the raw key', () => {
    render(
      <SnapshotList
        snapshots={[]}
        loading={false}
        creating={false}
        error="errors.daemonUnavailable"
        confirmDelete={null}
        onOpen={noop}
        onCreate={noop}
        onRetry={noop}
        onDelete={noop}
        onConfirmDelete={noop}
        accountEmail="user@example.com"
      />
    );

    expect(screen.getByText(en['errors.daemonUnavailable'])).toBeTruthy();
    expect(screen.queryByText('errors.daemonUnavailable')).toBeNull();
  });
});
