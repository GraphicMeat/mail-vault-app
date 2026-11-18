// Settings > Privacy & security on the phone: desktop's Security, Tracking and Encryption views
// (src/components/settings/views) over the phone's preferences and engine.
//
// - Security: link safety scanning and its click confirmation (the viewer asks before a flagged
//   link opens), and asking before external content loads (`holdExternalContent`), with what
//   every warning mark means (no screenshots: the phone bundles none).
// - Tracking: the tracking-pixel switch while Premium is on (the engine strips them then,
//   `trackerBlockingEnabled`), the upsell and the explainer otherwise; Upgrade opens the paywall.
//   What this phone has found (`mobile.tracking.stats`: messages with a pixel, the pixels, the
//   vendors found most, the bundled table's size) is desktop's section under it; until the engine
//   answers, or if it cannot, the section is left out. Its sources open in the system browser.
// - Encryption: the OpenPGP keys the engine decrypts with, in the phone's secret store behind
//   `mobile.pgp.*`. A pasted key goes to the engine once, on Import, and the field is cleared. A
//   key file goes through the system picker: the page gets only its handle, hands it straight to
//   the engine with the passphrase typed above, and the engine reads and deletes the copy.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SecurityView } from '../../components/settings/views/SecurityView';
import { SafetyAlertLegendView } from '../../components/settings/views/SafetyAlertLegendView';
import { TrackingView } from '../../components/settings/views/TrackingView';
import { EncryptionView } from '../../components/settings/views/EncryptionView';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { daemonCall, pickFiles } from '../transport.js';
import { MobileViewEnv, SaveFailed, openExternal, useSavePrefs } from './MobileViewEnv.jsx';

export function Security() {
  const prefs = useMobileStore((s) => s.prefs);
  const [save, failed] = useSavePrefs();
  return (
    <MobileViewEnv>
      <SecurityView values={prefs} onChange={(key, value) => save({ [key]: value })} legend={<SafetyAlertLegendView />} />
      <SaveFailed failed={failed} />
    </MobileViewEnv>
  );
}

export function Tracking() {
  const enabled = useMobileStore((s) => s.prefs.trackerBlockingEnabled);
  const premium = useMobileStore((s) => s.premium.premium);
  const [save, failed] = useSavePrefs();
  const [found, setFound] = useState(null);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.tracking.stats', {}).then((r) => { if (live && r) setFound(r); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const stats = found ? { messages: found.messages || 0, pixels: found.pixels || 0, top: Array.isArray(found.top) ? found.top : [] } : null;
  return (
    <MobileViewEnv>
      <TrackingView isPremium={premium} enabled={enabled} onToggle={(next) => save({ trackerBlockingEnabled: next })}
        onUpgrade={() => useMobileStore.getState().openPaywall(null)}
        stats={stats} patterns={Number.isInteger(found?.patterns) ? found.patterns : null} onOpenLink={openExternal} />
      <SaveFailed failed={failed} />
    </MobileViewEnv>
  );
}

export function Encryption() {
  const t = useT();
  const [keys, setKeys] = useState([]);
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // `call` names its method literally, so the seam scan (seam.js) can follow it.
  const run = useCallback(async (call) => {
    setBusy(true);
    setError(null);
    try {
      const reply = await call();
      if (mounted.current) setKeys(reply?.keys || []);
      return true;
    } catch (e) {
      if (mounted.current) setError(t('pgp.failed', { err: e?.message || String(e) }));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [t]);

  useEffect(() => { run(() => daemonCall('mobile.pgp.listKeys', {})); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importPasted = async () => {
    if (await run(() => daemonCall('mobile.pgp.importKey', { armored, passphrase })) && mounted.current) {
      setArmored('');
      setPassphrase('');
    }
  };

  const importFile = async () => {
    let picked;
    try {
      picked = await pickFiles('files');
    } catch (e) {
      setError(t('pgp.failed', { err: e?.message || String(e) }));
      return;
    }
    // Every picked file goes to the engine, which deletes each copy: none is left in the cache.
    const handles = picked.filter((f) => f.handle).map((f) => f.handle);
    if (handles.length === 0) return;
    let ok = true;
    for (const handle of handles) {
      // eslint-disable-next-line no-await-in-loop -- one import at a time, each replying with the list
      ok = (await run(() => daemonCall('mobile.pgp.importKey', { handle, passphrase }))) && ok;
    }
    if (ok && mounted.current) setPassphrase('');
  };

  return (
    <MobileViewEnv>
      <EncryptionView keys={keys} armored={armored} onArmored={setArmored} passphrase={passphrase} onPassphrase={setPassphrase}
        busy={busy} error={error} onImport={importPasted} onChooseFile={importFile}
        onRemove={(fingerprint) => run(() => daemonCall('mobile.pgp.removeKey', { fingerprint }))} />
    </MobileViewEnv>
  );
}
