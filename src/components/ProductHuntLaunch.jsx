import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { getLocale, useT } from '../i18n/index.js';
import { useSettingsStore } from '../stores/settingsStore';
import { openInBrowser } from '../services/billingApi';
import { LAUNCH_END, PRODUCT_HUNT_URL, launchLive, nextLaunchBoundary } from '../utils/productHuntLaunch';
import heroImage from '../assets/producthunt/launch-hero.webp';
import supportButton from '../assets/producthunt/support-button.webp';
import '../styles/product-hunt-launch.css';

// setTimeout stores its delay in 31 bits; a longer wait fires at once.
const MAX_TIMER = 2 ** 31 - 1;
// One sweep of the word takes this long; on activation it plays out at FINISH_RATE.
const SWEEP_MS = 10000;
const FINISH_RATE = 5;
// Brand name, never translated.
const WORD = 'PRODUCT HUNT';
const COPIES = [0, 1, 2, 3, 4, 5];
const SPARKS = [
  [6, 14, 1], [92, 10, 1.4], [14, 78, 1.2], [88, 72, 1], [4, 46, 0.8],
  [96, 42, 0.8], [30, 6, 0.8], [70, 92, 1.2], [48, 96, 0.8], [76, 5, 1],
];

// Tapping the button is the only way out, and it sticks across restarts.
const OPENED_KEY = 'mv.productHuntLaunch.opened';
const wasOpened = () => { try { return localStorage.getItem(OPENED_KEY) === '1'; } catch { return false; } };
const rememberOpened = () => { try { localStorage.setItem(OPENED_KEY, '1'); } catch { /* hidden for this run only */ } };

// Dev-only: `?phPreview` shows the page outside the launch window. E2E runs
// never show it, or a suite run on launch day would sit behind it. CI's
// ui-headless suite builds without VITE_E2E, so the WebDriver bridge counts
// too: `window.__WEBDRIVER__` is defined by tauri-plugin-webdriver-automation's
// init.js, compiled in only by the `webdriver` feature, which never ships.
const previewForced = () => import.meta.env.DEV && new URLSearchParams(window.location.search).has('phPreview');
const suppressed = () => import.meta.env.VITE_E2E === '1'
  || (typeof window !== 'undefined' && '__WEBDRIVER__' in window);
const shouldShow = (now, onboarded, completedAt) =>
  !suppressed() && (previewForced() || (onboarded && launchLive(now, completedAt)));

function useLaunchLive(onboarded, completedAt) {
  const [live, setLive] = useState(() => shouldShow(Date.now(), onboarded, completedAt));
  useEffect(() => {
    let timer;
    const sync = () => {
      const now = Date.now();
      setLive(shouldShow(now, onboarded, completedAt));
      clearTimeout(timer);
      const next = nextLaunchBoundary(now, completedAt);
      if (next != null) timer = setTimeout(sync, Math.min(next - now + 50, MAX_TIMER));
    };
    sync();
    // A slept laptop wakes with a stale timer; coming back re-reads the clock.
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [onboarded, completedAt]);
  return live;
}

function useWindowActive() {
  const read = () => document.hasFocus() && document.visibilityState !== 'hidden';
  const [active, setActive] = useState(read);
  useEffect(() => {
    const update = () => setActive(read());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return active;
}

const NOTE_TICK_MS = 30000;

function formatWhen(ms, locale) {
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(ms);
}

function formatLeft(ms, locale) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const unit = (n, u) => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h && unit(h, 'hour'), (m || !h) && unit(m, 'minute')].filter(Boolean).join(' ');
}

/** When the page ends, in the user's own timezone, and how long remains. */
function EndsNote({ settled }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOTE_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const locale = getLocale();
  return (
    <motion.p
      className="ph-note"
      initial={{ opacity: 0, y: 14 }}
      animate={settled ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.5, delay: 1 }}
    >
      <span>{t('productHunt.endsNote', { when: formatWhen(LAUNCH_END, locale) })}</span>
      <strong>{t('productHunt.timeLeft', { left: formatLeft(Math.max(0, LAUNCH_END - now), locale) })}</strong>
    </motion.p>
  );
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const Track = React.forwardRef(function Track(_, ref) {
  return (
    <div className="ph-track" ref={ref}>
      {COPIES.map(i => <span key={i}>{WORD}<i>★</i></span>)}
    </div>
  );
});

function LaunchPage({ onOpened }) {
  const t = useT();
  const active = useWindowActive();
  const [settled, setSettled] = useState(false);
  const trackRef = useRef(null);
  const sweepRef = useRef(null);
  const buttonRef = useRef(null);

  // Nothing behind the page may take focus, clicks or keys: `inert` covers the
  // first two, the capture listener the app's window-level shortcuts (Delete
  // would otherwise act on a message nobody can see). Enter and Space still
  // reach the button, as they are its default action, not a listener.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const swallow = (e) => e.stopImmediatePropagation();
    const keys = ['keydown', 'keyup', 'keypress'];
    keys.forEach(k => window.addEventListener(k, swallow, true));
    buttonRef.current?.focus();
    return () => {
      root?.removeAttribute('inert');
      keys.forEach(k => window.removeEventListener(k, swallow, true));
    };
  }, []);
  useEffect(() => {
    if (active) buttonRef.current?.focus();
  }, [active]);

  // The word sweeps right to left for as long as the window is in the
  // background. Activation lets the current sweep run out, fast, then hands
  // over to the hero and the button.
  useEffect(() => {
    const track = trackRef.current;
    if (!track?.animate || reducedMotion()) return undefined;
    const sweep = track.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-50%)' }],
      { duration: SWEEP_MS, iterations: Infinity, easing: 'linear' },
    );
    sweepRef.current = sweep;
    return () => { sweep.cancel(); sweepRef.current = null; };
  }, []);
  useEffect(() => {
    if (!active || settled) return undefined;
    const sweep = sweepRef.current;
    if (!sweep) { setSettled(true); return undefined; }
    const timing = sweep.effect;
    timing.updateTiming({ iterations: Math.floor(timing.getComputedTiming().currentIteration ?? 0) + 1 });
    sweep.updatePlaybackRate(FINISH_RATE);
    const done = () => setSettled(true);
    sweep.finished.then(done, () => {});
    // If the page clock is throttled (window hidden) `finished` can stall, so
    // never wait longer than the sweep's own remaining time at the fast rate.
    const left = (1 - (timing.getComputedTiming().progress ?? 0)) * SWEEP_MS / FINISH_RATE;
    const guard = setTimeout(done, left + 150);
    return () => clearTimeout(guard);
  }, [active, settled]);

  // Hide only once the browser really opened; a failed open leaves the button to retry.
  const open = () => { openInBrowser(PRODUCT_HUNT_URL).then(onOpened, () => {}); };
  const phase = settled ? 'settled' : active ? 'finishing' : 'idle';

  return (
    <div
      className="ph-launch"
      role="dialog"
      aria-modal="true"
      aria-label={t('productHunt.dialogLabel')}
      data-tauri-drag-region
      data-testid="product-hunt-launch"
      data-phase={phase}
    >
      <div className="ph-dots" aria-hidden="true" />
      {SPARKS.map(([x, y, s], i) => (
        <span key={i} className="ph-spark" aria-hidden="true"
          style={{ '--x': `${x}%`, '--y': `${y}%`, '--s': s, '--d': `${(i * 0.37).toFixed(2)}s` }} />
      ))}

      <div className="ph-marquee" data-settled={settled || undefined} aria-hidden="true">
        <div className="ph-row ph-row-ghost ph-row-top"><Track /></div>
        <div className="ph-row"><Track ref={trackRef} /></div>
        <div className="ph-row ph-row-ghost ph-row-bottom"><Track /></div>
      </div>

      <div className="ph-stage">
        <motion.div
          className="ph-hero"
          initial={{ opacity: 0, scale: 0.5, rotate: -12, y: 70 }}
          animate={settled ? { opacity: 1, scale: 1, rotate: 0, y: 0 } : undefined}
          transition={{ type: 'spring', stiffness: 170, damping: 12, mass: 0.9, delay: 0.2 }}
        >
          {settled && <span className="ph-burst" aria-hidden="true" />}
          <img className="ph-hero-img" src={heroImage} alt="" width="1000" height="1000" draggable={false} />
        </motion.div>
        <motion.button
          ref={buttonRef}
          type="button"
          className="ph-cta"
          aria-label={t('productHunt.openLabel')}
          data-testid="product-hunt-open"
          onClick={open}
          initial={{ opacity: 0, y: 110, scale: 0.8 }}
          animate={settled ? { opacity: 1, y: 0, scale: 1 } : undefined}
          transition={{ type: 'spring', stiffness: 210, damping: 14, delay: 0.55 }}
          whileHover={{ scale: 1.035, y: -3, transition: { type: 'spring', stiffness: 400, damping: 20 } }}
          whileTap={{ scale: 0.97, y: 3, transition: { duration: 0.08 } }}
        >
          <span className="ph-cta-face" data-live={settled || undefined} style={{ '--ph-btn': `url(${supportButton})` }}>
            <img src={supportButton} alt="" width="1982" height="382" draggable={false} />
            <span className="ph-cta-shine" aria-hidden="true" />
          </span>
        </motion.button>
        <EndsNote settled={settled} />
      </div>
    </div>
  );
}

export function ProductHuntLaunch() {
  const onboarded = useSettingsStore(st => st.onboardingComplete);
  const completedAt = useSettingsStore(st => st.onboardingCompletedAt);
  const live = useLaunchLive(onboarded, completedAt);
  const [opened, setOpened] = useState(wasOpened);
  const onOpened = () => { rememberOpened(); setOpened(true); };
  return live && !opened ? createPortal(<LaunchPage onOpened={onOpened} />, document.body) : null;
}
