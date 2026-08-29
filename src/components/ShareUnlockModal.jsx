import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { Gift, Github, Star, Check, Loader, X as XIcon, ExternalLink, AlertCircle } from 'lucide-react';
import { useBackupStore } from '../stores/backupStore';
import { useSettingsStore } from '../stores/settingsStore';
import { openInBrowser } from '../services/billingApi';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { XLogo, LinkedInLogo } from './ui/BrandGlyphs';
import {
  GITHUB_REPO_URL,
  REWARD_DAYS,
  buildShareText,
  xIntentUrl,
  linkedinShareUrl,
} from '../config/shareUnlock';
import { useT } from '../i18n/index.js';

const invoke = () => window.__TAURI__?.core?.invoke;

/**
 * Share-to-unlock panel — combines: (1) milestone trigger, (3) prefilled
 * actions, (4) visible stackable reward, (6) product-native copy. Shown after
 * an eligible backup; grants free premium for starring + sharing.
 */
export default function ShareUnlockModal({ onSubscribe }) {
  const t = useT();
  const shareUnlock = useBackupStore(s => s.shareUnlock);
  const clearShareUnlock = useBackupStore(s => s.clearShareUnlock);
  const shareGrant = useSettingsStore(s => s.shareGrant);
  const recordShareAction = useSettingsStore(s => s.recordShareAction);

  const emailsBackedUp = shareUnlock?.emailsBackedUp || 0;

  // GitHub device-flow state.
  const [gh, setGh] = useState({ stage: 'idle', userCode: '', uri: '', error: '' });
  const ghToken = useRef(null);
  const polling = useRef(false);

  // Honor-system social confirm reveal: { x: bool, linkedin: bool }
  const [revealed, setRevealed] = useState({ x: false, linkedin: false });

  // Stop polling if the panel closes.
  useEffect(() => () => { polling.current = false; }, []);

  const close = () => {
    polling.current = false;
    clearShareUnlock();
  };

  const titleId = useId();

  const claimDate = shareGrant?.expiresAt
    ? new Date(shareGrant.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  // ── GitHub verified flow ──────────────────────────────────────────────────
  const verifyStar = useCallback(async (token) => {
    const inv = invoke();
    if (!inv) return;
    setGh(g => ({ ...g, stage: 'verifying', error: '' }));
    try {
      const starred = await inv('github_check_star', { accessToken: token });
      if (starred) {
        recordShareAction('github', REWARD_DAYS.github);
        setGh(g => ({ ...g, stage: 'done' }));
      } else {
        setGh(g => ({ ...g, stage: 'needs_star' }));
      }
    } catch (e) {
      setGh(g => ({ ...g, stage: 'needs_star', error: String(e?.message || e) }));
    }
  }, [recordShareAction]);

  const pollLoop = useCallback(async (deviceCode, intervalSec) => {
    const inv = invoke();
    if (!inv) return;
    let wait = (intervalSec || 5) * 1000;
    while (polling.current) {
      await new Promise(r => setTimeout(r, wait));
      if (!polling.current) return;
      let res;
      try {
        res = await inv('github_device_poll', { deviceCode });
      } catch (e) {
        setGh(g => ({ ...g, stage: 'error', error: String(e?.message || e) }));
        polling.current = false;
        return;
      }
      if (res.status === 'authorized') {
        polling.current = false;
        ghToken.current = res.accessToken;
        verifyStar(res.accessToken);
        return;
      }
      if (res.status === 'slow_down') { wait += 5000; continue; }
      if (res.status === 'pending') continue;
      // expired | denied | error
      setGh(g => ({ ...g, stage: 'error', error: `Authorization ${res.status}. Try again.` }));
      polling.current = false;
      return;
    }
  }, [verifyStar]);

  const startGithub = async () => {
    const inv = invoke();
    if (!inv) { setGh(g => ({ ...g, stage: 'error', error: 'Desktop app required.' })); return; }
    setGh({ stage: 'starting', userCode: '', uri: '', error: '' });
    try {
      const r = await inv('github_device_start');
      setGh({ stage: 'awaiting', userCode: r.userCode, uri: r.verificationUri, error: '' });
      openInBrowser(r.verificationUri).catch(() => {});
      polling.current = true;
      pollLoop(r.deviceCode, r.interval);
    } catch (e) {
      setGh({ stage: 'error', userCode: '', uri: '', error: String(e?.message || e) });
    }
  };

  // ── Honor-system social ───────────────────────────────────────────────────
  const openSocial = (action) => {
    const url = action === 'x'
      ? xIntentUrl(buildShareText(emailsBackedUp))
      : linkedinShareUrl();
    openInBrowser(url).catch(() => {});
    setRevealed(r => ({ ...r, [action]: true }));
  };

  const claimSocial = (action) => recordShareAction(action, REWARD_DAYS[action]);

  if (!shareUnlock) return null;

  const milestone = emailsBackedUp > 0
    ? `${emailsBackedUp.toLocaleString()} emails just landed safely in your vault.`
    : `Your backup just finished.`;

  return (
    <Dialog
      open
      onClose={close}
      padded={false}
      panelBg="bg-mail-surface"
      aria-labelledby={titleId}
      panelClassName="overflow-hidden"
    >
          {/* Header */}
          <div className="p-5 pb-4 border-b border-mail-border">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-mail-surface-hover">
                  <Gift size={20} className="text-mail-accent-text" />
                </div>
                <div>
                  <h2 id={titleId} className="text-base font-semibold text-mail-text">{t('shareUnlock.unlockPremiumFree')}</h2>
                  <p className="text-xs text-mail-text-muted">{milestone}</p>
                </div>
              </div>
              <Button variant="ghost" icon size="xs" onClick={close} aria-label={t('common.close')}>
                <XIcon size={18} />
              </Button>
            </div>
            <p className="text-sm text-mail-text-muted mt-3">
              Star us and share MailVault — unlock Cloud Backups & Time Capsule free.
              Each one adds time. They stack.
            </p>
          </div>

          {/* Actions */}
          <div className="p-3 space-y-2">
            <GithubRow
              done={!!shareGrant?.github}
              gh={gh}
              onStart={startGithub}
              onOpenRepo={() => openInBrowser(GITHUB_REPO_URL).catch(() => {})}
              onRecheck={() => ghToken.current && verifyStar(ghToken.current)}
            />
            <SocialRow
              icon={<XLogo />}
              label="Share on X"
              days={REWARD_DAYS.x}
              done={!!shareGrant?.x}
              revealed={revealed.x}
              onOpen={() => openSocial('x')}
              onClaim={() => claimSocial('x')}
            />
            <SocialRow
              icon={<LinkedInLogo />}
              label="Share on LinkedIn"
              days={REWARD_DAYS.linkedin}
              done={!!shareGrant?.linkedin}
              revealed={revealed.linkedin}
              onOpen={() => openSocial('linkedin')}
              onClaim={() => claimSocial('linkedin')}
            />
          </div>

          {/* Subscribe fallback */}
          {onSubscribe && (
            <div className="px-3 pb-2">
              <button
                onClick={() => { close(); onSubscribe(); }}
                className="w-full text-center text-xs text-mail-text-muted hover:text-mail-accent-text py-1"
              >
                Prefer not to share? Subscribe instead →
              </button>
            </div>
          )}

          {/* Footer */}
          <div className="px-5 py-4 border-t border-mail-border flex items-center justify-between">
            <div className="text-xs">
              {claimDate ? (
                <span className="text-mail-accent-text font-medium">Premium unlocked until {claimDate}</span>
              ) : (
                <span className="text-mail-text-muted">{t('shareUnlock.pickAnyActionStart')}</span>
              )}
            </div>
            <Button variant="ghost" size="xs" onClick={close}>
              {t('shareUnlock.maybeLater')}
            </Button>
          </div>
    </Dialog>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

function RowShell({ icon, label, days, done, children }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-mail-bg border border-mail-border">
      <div className="shrink-0 text-mail-text">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-mail-text">{label}</div>
        <div className="text-xs text-mail-text-muted">{done ? 'Unlocked' : `+${days} days`}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function GithubRow({ done, gh, onStart, onOpenRepo, onRecheck }) {
  const t = useT();
  let control;
  if (done) {
    control = <DoneBadge />;
  } else if (gh.stage === 'starting' || gh.stage === 'verifying') {
    control = <Loader size={16} className="text-mail-text-muted animate-spin" />;
  } else if (gh.stage === 'awaiting') {
    control = (
      <div className="text-right">
        <div className="text-[11px] text-mail-text-muted">{t('shareUnlock.enterCodeGithub')}</div>
        <code className="text-sm font-mono font-semibold text-mail-accent-text tracking-widest">{gh.userCode}</code>
      </div>
    );
  } else if (gh.stage === 'needs_star') {
    control = (
      <div className="flex flex-col items-end gap-1">
        <BtnPrimary onClick={onOpenRepo}><Star size={13} /> {t('shareUnlock.starRepo')}</BtnPrimary>
        <button onClick={onRecheck} className="text-[11px] text-mail-accent-text hover:underline">{t('shareUnlock.iStarredVerify')}</button>
      </div>
    );
  } else {
    control = <BtnPrimary onClick={onStart}><Star size={13} /> {t('shareUnlock.star')}</BtnPrimary>;
  }
  return (
    <div>
      <RowShell icon={<Github size={20} />} label="Star on GitHub" days={REWARD_DAYS.github} done={done}>
        {control}
      </RowShell>
      {gh.error && (
        <div className="flex items-center gap-1.5 px-3 pt-1 text-[11px] text-mail-danger">
          <AlertCircle size={12} /> {gh.error}
        </div>
      )}
    </div>
  );
}

function SocialRow({ icon, label, days, done, revealed, onOpen, onClaim }) {
  const t = useT();
  let control;
  if (done) control = <DoneBadge />;
  else if (revealed) control = <BtnPrimary onClick={onClaim}><Check size={13} /> {t('shareUnlock.iSharedClaim')}</BtnPrimary>;
  else control = <BtnPrimary onClick={onOpen}><ExternalLink size={13} /> {t('shareUnlock.share')}</BtnPrimary>;
  return <RowShell icon={icon} label={label} days={days} done={done}>{control}</RowShell>;
}

function DoneBadge() {
  const t = useT();
  return (
    <span className="flex items-center gap-1 text-xs font-medium text-mail-success">
      <Check size={15} /> {t('common.done')}
    </span>
  );
}

function BtnPrimary({ onClick, children }) {
  return (
    <Button variant="primary" size="sm" className="text-xs font-medium" onClick={onClick}>
      {children}
    </Button>
  );
}

