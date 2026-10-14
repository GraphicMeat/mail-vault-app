// @vitest-environment jsdom
import React, { createRef, forwardRef, useImperativeHandle, useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
const tilesProps = vi.hoisted(() => ({ hold: false }));
vi.mock('../BlitzTiles', () => ({
  default: forwardRef(function TilesStub(p, ref) {
    const el = useRef(null);
    useImperativeHandle(ref, () => ({ layerEl: () => el.current }), []);
    return <div ref={el} data-testid="layer-stub"><button onClick={() => p.onFailure('render_unavailable')}>fail</button></div>;
  }),
}));
vi.mock('../prepass/privacyDict', () => ({ usePrivacyDict: () => ({ active: false, dict: null, hold: tilesProps.hold }) }));
import BlitzBody from '../BlitzBody';

afterEach(() => { cleanup(); tilesProps.hold = false; });

const props = { surface: 'reader', messageKey: 'k-handle', bodyHtml: '<p>Hello</p>', plainText: 'Hello', theme: { dark: false, palette: 'graphite' }, onLink: vi.fn(), sizing: 'content' };

describe('BlitzBody handle', () => {
  it('selectionRoot is the tiles text layer', async () => {
    const ref = createRef();
    render(<BlitzBody ref={ref} {...props} />);
    await waitFor(() => expect(screen.getByTestId('layer-stub')).toBeTruthy());
    expect(ref.current.selectionRoot()).toBe(screen.getByTestId('layer-stub'));
  });

  it('selectionRoot is null while held for privacy', async () => {
    tilesProps.hold = true;
    const ref = createRef();
    render(<BlitzBody ref={ref} {...props} messageKey="k-handle-hold" />);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId('layer-stub')).toBeNull();
    expect(ref.current.selectionRoot()).toBeNull();
  });

  it('selectionRoot is null after a failure: the plain fallback is not the selection root', async () => {
    const ref = createRef();
    render(<BlitzBody ref={ref} {...props} messageKey="k-handle-fail" />);
    fireEvent.click(await screen.findByText('fail'));
    await screen.findByTestId('blitz-failure-notice');
    expect(ref.current.selectionRoot()).toBeNull();
  });
});
