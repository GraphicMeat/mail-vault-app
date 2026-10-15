// Core seam for alternative email-body renderers (today: the Blitz module in
// src/features/blitz, registered by its own index from main.jsx). With no
// renderer registered, or the setting on 'web', every hook here returns null
// and each surface draws its iframe exactly as before.
import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';

const renderers = new Map(); // name -> { Body, SettingsRow }

export function registerBodyRenderer(name, impl) { renderers.set(name, impl); }
export function _resetBodyRenderersForTest() { renderers.clear(); }

/**
 * The component a surface draws instead of its iframe, or null.
 * A Body that receives a ref must be a forwardRef exposing { selectionRoot(), selectionText() }
 * (the Reply quote reads the selection through them; see features/blitz/types.js AltBodyHandle).
 */
// eslint-disable-next-line no-unused-vars
export function useAltBodyRenderer(surface) {
  const mode = useSettingsStore(s => s.emailRenderer);
  const impl = mode && mode !== 'web' ? renderers.get(mode) : null;
  return impl?.Body ?? null;
}

/** Settings > Appearance rows contributed by registered renderers. */
export function BodyRendererSettingsSlot() {
  const rows = [...renderers.values()].map(r => r.SettingsRow).filter(Boolean);
  return <>{rows.map((Row, i) => <Row key={i} />)}</>;
}

/** The active renderer's whole impl, for code outside React (export, capture), or null. */
export function getActiveBodyRenderer() {
  const mode = useSettingsStore.getState().emailRenderer;
  return mode && mode !== 'web' ? renderers.get(mode) ?? null : null;
}

/** The same, as a hook: re-renders when the setting changes. */
export function useActiveBodyRenderer() {
  const mode = useSettingsStore(s => s.emailRenderer);
  return mode && mode !== 'web' ? renderers.get(mode) ?? null : null;
}
