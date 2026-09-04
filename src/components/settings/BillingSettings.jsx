import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { useAccountStore } from '../../stores/accountStore';
import { useBackupStore } from '../../stores/backupStore';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import {
  createCheckoutSession, createPortalSession, fetchSubscriptionStatus, fetchPricing,
  unregisterBillingClient, getClientInfo, openInBrowser,
  isBillingRateLimited, getBillingRateLimitedUntil, BillingRateLimitError,
} from '../../services/billingApi';
import { notify } from '../../stores/focusStore';
import { ConfirmDialog } from '../ConfirmDialog';
import { PremiumFeaturesLink } from '../PremiumFeaturesLink';
import { PremiumFeatureList } from './PremiumFeatureList';
import { Toast } from '../Toast';
import { formatDateLong, formatTime } from '../../utils/dateFormat';
import { pricingRecord } from '../../utils/pricing';
import {
  CreditCard,
  CheckCircle2,
  Gift,
  Loader,
  ExternalLink,
  RefreshCw,
  Clock,
  Shield,
  HardDrive,
  Mail,
  ArrowLeftRight,
  Trash2,
  ImageDown,
  Monitor,
  X,
  LogOut,
} from 'lucide-react';
import { t as tr, t, useT   } from '../../i18n/index.js';

// Cooldown constants
const AUTO_REFRESH_COOLDOWN = 60_000;  // 60s for focus/mount
const MANUAL_REFRESH_COOLDOWN = 10_000; // 10s for button clicks
const STALE_THRESHOLD = 3600_000;       // 1h before mount auto-refresh

function formatDate(dateStr) {
  if (!dateStr) return '--';
  return formatDateLong(dateStr) || '--';
}

/**
 * Why a sign-in that reached the server still left the user without premium.
 * Pure — the server always answers 200 for an unknown email, so this is the
 * only thing standing between "nothing happened" and an explanation.
 */
export function signInFailureNotice(result, { appStore = IS_APPSTORE_BUILD } = {}) {
  if (!result) return null;
  // App Store builds show no plan cards, so copy must not point at them or
  // otherwise steer the user toward buying outside the App Store.
  if (!result.hasSubscription) {
    if (appStore) {
      return result.customerId
        ? t('settings.billing.noActiveSubscriptionEmail')
        : t('settings.billing.noSubscriptionFoundEmailSign');
    }
    return result.customerId
      ? t('settings.billing.noActiveSubscriptionEmailPick')
      : t('settings.billing.noSubscriptionFoundEmailPick');
  }
  if (result.premiumAccess && result.clientAccessGranted === false) {
    return t('settings.billing.subscriptionActiveButDeviceCould');
  }
  switch (result.status) {
    case 'canceled':
      return appStore
        ? t('settings.billing.subscriptionEnded')
        : t('settings.billing.subscriptionEndedPickPlanBelow');
    case 'past_due':
    case 'unpaid':
      return appStore
        ? t('settings.billing.paymentFailedSubscriptionUpdatePayment')
        : t('settings.billing.paymentFailedSubscriptionUpdatePayment2');
    case 'incomplete':
    case 'incomplete_expired':
      return appStore
        ? t('settings.billing.checkoutWasNeverCompletedEmail')
        : t('settings.billing.checkoutWasNeverCompletedEmail2');
    default:
      return appStore
        ? t('settings.billing.subscriptionStatusDoesGrantPremium', { result: result.status || 'unknown' })
        : t('settings.billing.subscriptionStatusDoesGrantPremium2', { result: result.status || 'unknown' });
  }
}

/**
 * Why premium just stopped, for a refresh that used to grant it.
 *
 * A subscription can end between two refreshes — it lapses, payment fails, or
 * the device loses its seat to another machine. Before this, the app simply
 * re-rendered as Free: premium features stopped with no message anywhere, and
 * the only way to find out was to notice something missing (2026-08-27).
 *
 * `null` when there is nothing to announce — no access before, or access kept.
 */
export function premiumDropNotice(previous, next, { appStore = IS_APPSTORE_BUILD } = {}) {
  if (!hasPremiumAccess(previous)) return null;
  if (hasPremiumAccess(next)) return null;
  const reason = signInFailureNotice(next, { appStore });
  return reason
    ? t('settings.billing.premiumAccessEndedDevice', { reason })
    : t('settings.billing.premiumAccessEndedDevice2');
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('settings.billing.justNow');
  if (mins < 60) return t('settings.billing.mAgo', { mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('settings.billing.hAgo', { hrs });
  return t('settings.billing.dAgo', { Math: Math.floor(hrs / 24) });
}

export function BillingSettings({ onNavigate }) {
  const t = useT();
  const billingEmail = useSettingsStore(s => s.billingEmail);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const billingLastChecked = useSettingsStore(s => s.billingLastChecked);
  const setBillingEmail = useSettingsStore(s => s.setBillingEmail);
  const setBillingProfile = useSettingsStore(s => s.setBillingProfile);
  const accounts = useAccountStore(s => s.accounts);

  // Deduplicated list of account emails
  const accountEmails = useMemo(() => {
    const seen = new Set();
    return accounts
      .map(a => a.email)
      .filter(Boolean)
      .filter(e => { const lower = e.toLowerCase(); if (seen.has(lower)) return false; seen.add(lower); return true; });
  }, [accounts]);

  // Selected email: prefer billingEmail if it matches an account, else first account
  const [selectedEmail, setSelectedEmail] = useState(() => {
    if (billingEmail && accountEmails.some(e => e.toLowerCase() === billingEmail.toLowerCase())) {
      return billingEmail;
    }
    return accountEmails[0] || '';
  });

  // Keep selected email in sync if accounts change
  useEffect(() => {
    if (selectedEmail && accountEmails.some(e => e.toLowerCase() === selectedEmail.toLowerCase())) return;
    // Current selection is stale — reset to first account or billingEmail
    if (billingEmail && accountEmails.some(e => e.toLowerCase() === billingEmail.toLowerCase())) {
      setSelectedEmail(billingEmail);
    } else if (accountEmails.length > 0) {
      setSelectedEmail(accountEmails[0]);
    }
  }, [accountEmails]);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);      // transient: cleared on next successful refresh
  const [rateLimitMsg, setRateLimitMsg] = useState(null); // transient: cleared on next successful refresh or cooldown expiry
  const [showingCached, setShowingCached] = useState(false); // transient: true only while last request failed AND cached data exists
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);
  // emailError removed — dropdown prevents invalid input
  const [replacedNotice, setReplacedNotice] = useState(null);
  const [removingClientId, setRemovingClientId] = useState(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [pricing, setPricing] = useState(null); // { currency, currencySource, plans: [...] }
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState(null);
  const [signInNotice, setSignInNotice] = useState(null); // why the last sign-in granted nothing

  const inflightRef = useRef(false);
  const refreshPromiseRef = useRef(null);
  const clientInfoRef = useRef(null);
  const lastRefreshRef = useRef(0);
  const visibleRef = useRef(true); // assume visible on mount

  const isPremium = hasPremiumAccess(billingProfile);
  const customerId = billingProfile?.customerId;
  const activeClients = billingProfile?.activeClients || [];
  const clientLimit = billingProfile?.clientLimit || 5;
  const activeClientCount = billingProfile?.activeClientCount || 0;
  const currentClientId = billingProfile?.currentClientId || clientInfoRef.current?.clientId;

  // Derived sign-in state — must be declared before any effects that reference it
  const isSignedIn = isPremium && !!billingEmail;
  const signInDisabled = syncing || !selectedEmail || cooldownRemaining > 0;
  const signInLabel = syncing ? t('settings.billing.signing')
    : cooldownRemaining > 0 ? t('settings.billing.waitS', { cooldownRemaining })
    : t('settings.billing.signPremium');
  const statusLabel = !billingProfile?.hasSubscription ? t('settings.billing.free')
    : billingProfile.status === 'active' ? t('settings.billing.premium', { billingProfile: billingProfile.interval === 'year' ? tr('settings.billing.yearly') : tr('settings.billing.monthly') })
    : billingProfile.status === 'trialing' ? t('settings.billing.premiumTrial')
    : billingProfile.status === 'past_due' ? t('settings.billing.premiumPastDue')
    : billingProfile.status === 'canceled' ? t('settings.billing.canceled')
    : billingProfile.status || 'Unknown';

  // Load client info once
  useEffect(() => { getClientInfo().then(info => { clientInfoRef.current = info; }); }, []);

  // Pass email/customerId so server can check trial eligibility
  const loadPricing = useCallback(async (email) => {
    setPricingLoading(true);
    setPricingError(null);
    try {
      const res = await fetchPricing({ email: email || billingEmail, customerId });
      setPricing(res);
      // Share the resolved currency with the feature overlays — they must never
      // quote a different one than the plan cards right here.
      const record = pricingRecord(res);
      if (record) useSettingsStore.getState().setPremiumPricing(record);
    } catch (e) {
      // The API answers 503 with a bare code (`pricing_unavailable`) and no prose.
      const msg = e.message || '';
      setPricingError(/\s/.test(msg) ? msg : t('settings.billing.billingServiceTemporarilyUnavailable'));
    } finally {
      setPricingLoading(false);
    }
  }, [billingEmail, customerId]);

  // Fetch pricing on mount (only when not premium — plan cards are hidden for premium users)
  useEffect(() => {
    if (!IS_APPSTORE_BUILD && !isPremium && !pricing && !pricingLoading) loadPricing();
  }, [isPremium]);

  // Cooldown ticker — count down when rate-limited or in manual cooldown
  useEffect(() => {
    const id = setInterval(() => {
      const rlUntil = getBillingRateLimitedUntil();
      const cooldownUntil = lastRefreshRef.current + MANUAL_REFRESH_COOLDOWN;
      const until = Math.max(rlUntil, cooldownUntil);
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setCooldownRemaining(remaining);
      if (remaining === 0 && rateLimitMsg) setRateLimitMsg(null);
    }, 1000);
    return () => clearInterval(id);
  }, [rateLimitMsg]);

  // ── Billing API helpers ─────────────────────────────────────────────────────

  // Shared request logic — used by both sign-in and refresh paths
  const billingRequest = useCallback(async ({ email, customerId, manual = false }) => {
    if (!email && !customerId) return;

    const cooldown = manual ? MANUAL_REFRESH_COOLDOWN : AUTO_REFRESH_COOLDOWN;
    if (Date.now() - lastRefreshRef.current < cooldown) return;
    if (isBillingRateLimited()) return;
    if (inflightRef.current && refreshPromiseRef.current) return refreshPromiseRef.current;

    inflightRef.current = true;
    setSyncing(true);
    setSyncError(null);

    const promise = (async () => {
      try {
        const clientInfo = clientInfoRef.current || await getClientInfo();
        clientInfoRef.current = clientInfo;

        const result = await fetchSubscriptionStatus({
          customerId, email,
          clientId: clientInfo.clientId,
          register: true,
          clientName: clientInfo.clientName,
          platform: clientInfo.platform,
          appVersion: clientInfo.appVersion,
          osVersion: clientInfo.osVersion,
        });

        lastRefreshRef.current = Date.now();
        setSyncError(null);
        setRateLimitMsg(null);
        setShowingCached(false);

        if (result.replacedClient) {
          setReplacedNotice(`Replaced device "${result.replacedClient.clientName || result.replacedClient.clientId}" to make room.`);
          setTimeout(() => setReplacedNotice(null), 8000);
        }

        return result;
      } catch (e) {
        if (e instanceof BillingRateLimitError) {
          setRateLimitMsg(e.message);
          setSyncError(null);
        } else {
          setSyncError(e.message || 'Could not reach billing server.');
          setRateLimitMsg(null);
        }
        const currentProfile = useSettingsStore.getState().billingProfile;
        if (currentProfile?.hasSubscription != null) setShowingCached(true);
        return null;
      } finally {
        setSyncing(false);
        inflightRef.current = false;
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = promise;
    return promise;
  }, [setBillingProfile, setBillingEmail]);

  // Sign in: email-only lookup, NO customerId — prevents stale identity reuse
  const signInWithEmail = useCallback(async (email) => {
    setSignInNotice(null);
    const result = await billingRequest({ email, customerId: undefined, manual: true });
    if (!result) return; // network/rate-limit paths surface via syncError / rateLimitMsg

    setBillingProfile(result);

    // If the API resolved to a different canonical email, use that
    const resolvedEmail = result.customerEmail || email;
    setBillingEmail(resolvedEmail);
    setSelectedEmail(resolvedEmail);

    // If no premium access, clear the persisted identity so we stay signed out
    if (!hasPremiumAccess(result)) {
      setBillingEmail('');
      setSignInNotice(signInFailureNotice(result));
      // Re-price for this email — trial eligibility is per customer, and the
      // mount fetch ran before we knew who they were. No cards in MAS, no fetch.
      if (!IS_APPSTORE_BUILD) loadPricing(resolvedEmail);
    }
  }, [billingRequest, setBillingProfile, setBillingEmail, loadPricing]);

  // Refresh: uses stored billing identity (customerId + email) — only when signed in
  const refreshSignedIn = useCallback(async ({ manual = false } = {}) => {
    const cid = billingProfile?.customerId;
    const email = billingEmail;
    if (!cid && !email) return;

    const previous = billingProfile;
    const result = await billingRequest({ email, customerId: cid, manual });
    if (!result) return;

    setBillingProfile(result);

    const dropped = premiumDropNotice(previous, result);
    if (dropped) {
      // Same treatment as a sign-in that granted nothing: say why, and drop the
      // stored identity so the UI shows a signed-out state instead of a signed-in
      // one with no access. The OS notification is the half the user sees when
      // this lands while they are looking at anything but this tab.
      setSignInNotice(dropped);
      setBillingEmail('');
      notify('MailVault Premium is no longer active', dropped);
      if (!IS_APPSTORE_BUILD) loadPricing(result.customerEmail || email);
      return;
    }

    if (result.customerEmail && result.customerEmail !== email) {
      setBillingEmail(result.customerEmail);
    }
  }, [billingEmail, billingProfile, billingRequest, setBillingProfile, setBillingEmail, loadPricing]);

  // Focus refresh — only when signed in and Billing tab is visible
  useEffect(() => {
    const onFocus = () => {
      if (!visibleRef.current) return;
      if (isSignedIn) refreshSignedIn();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isSignedIn, refreshSignedIn]);

  // Mount refresh — only when signed in and data is stale
  useEffect(() => {
    if (isSignedIn && (!billingLastChecked || Date.now() - billingLastChecked > STALE_THRESHOLD)) {
      refreshSignedIn();
    }
  }, []);

  // Track visibility (IntersectionObserver for the component root)
  const rootRef = useRef(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(([entry]) => { visibleRef.current = entry.isIntersecting; }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const handleSignIn = () => {
    const email = (selectedEmail || '').trim().toLowerCase();
    if (!email) return;
    signInWithEmail(email);
  };

  const handleCheckout = async (planId) => {
    setCheckoutError(null);
    const email = selectedEmail.trim().toLowerCase();
    if (!email) { setCheckoutError('Select an account email first.'); return; }
    setCheckoutLoading(planId);
    try {
      setBillingEmail(email);
      const { url, customerId: newCustomerId } = await createCheckoutSession(email, { planId });
      if (newCustomerId) setBillingProfile({ ...billingProfile, customerId: newCustomerId, customerEmail: email });
      try { await openInBrowser(url); } catch (browserErr) { setCheckoutError(browserErr.message); }
    } catch (e) {
      setCheckoutError(e.message || 'Could not start checkout.');
    } finally { setCheckoutLoading(null); }
  };

  const handleManageBilling = async () => {
    try {
      const { url } = await createPortalSession(customerId, billingEmail);
      await openInBrowser(url);
    } catch (e) { setSyncError(e.message || 'Could not open billing portal.'); }
  };

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutToast, setLogoutToast] = useState(null); // { message, type }

  const handleBillingLogout = async () => {
    setLogoutLoading(true);
    let warning = null;
    try {
      const clientInfo = await getClientInfo();
      if (customerId && billingEmail) {
        await unregisterBillingClient({ customerId, email: billingEmail, clientId: clientInfo.clientId });
      }
    } catch (e) {
      console.warn('[BillingSettings] Unregister failed during logout:', e.message);
      warning = 'Could not release the device seat. This device may still count toward your device limit until the subscription syncs.';
    }
    // Always clear local state regardless of server call success
    useSettingsStore.getState().clearBillingProfile();
    setSelectedEmail(accountEmails[0] || '');
    setSyncError(null);
    setSignInNotice(null);
    setLogoutLoading(false);
    setShowLogoutConfirm(false);

    if (warning) {
      setLogoutToast({ message: warning, type: 'warning' });
    } else {
      setLogoutToast({ message: t('settings.billing.signedOutPremiumDevice'), type: 'success' });
    }
  };

  const handleRemoveClient = async (clientId) => {
    setRemovingClientId(clientId);
    try {
      const result = await unregisterBillingClient({ customerId, email: billingEmail, clientId });
      setBillingProfile({ ...billingProfile, ...result });
    } catch (e) { setSyncError(e.message || 'Could not remove device.'); }
    finally { setRemovingClientId(null); }
  };

  return (
    <div ref={rootRef} className="p-6 space-y-6">
      {/* Transient warning banners — cleared immediately on next successful refresh */}
      {rateLimitMsg && (
        <div className="p-3 rounded-lg bg-mail-warning-tint border border-mail-warning/20 text-xs text-mail-warning">
          {rateLimitMsg}
          {showingCached && <span className="block mt-1 text-mail-text-muted">{t('settings.billing.showingLastKnownBillingData')}</span>}
        </div>
      )}
      {!rateLimitMsg && showingCached && (
        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border text-xs text-mail-text-muted">
          {t('settings.billing.showingCachedBillingDataWill')}
        </div>
      )}

      {/* Current Plan */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPremium ? 'bg-mail-accent-tint' : 'bg-mail-accent/10'}`}>
            {isPremium ? <CheckCircle2 size={20} className="text-mail-accent-text" /> : <CreditCard size={20} className="text-mail-accent-text" />}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">{statusLabel}</h3>
            {billingProfile?.status === 'trialing' && billingProfile?.currentPeriodEnd && (
              <p className="text-xs text-mail-accent-text">
                {t('settings.billing.freeTrialEndsYearlyBilling', { date: formatDate(billingProfile.currentPeriodEnd) })}
              </p>
            )}
            {isPremium && billingProfile?.status !== 'trialing' && billingProfile?.currentPeriodEnd && (
              <p className="text-xs text-mail-text-muted">
                {billingProfile.cancelAtPeriodEnd
                  ? t('settings.billing.accessUntil', { formatDate: formatDate(billingProfile.currentPeriodEnd) })
                  : t('settings.billing.renews', { formatDate: formatDate(billingProfile.currentPeriodEnd) })}
              </p>
            )}
            {billingProfile?.status === 'past_due' && (
              <p className="text-xs text-mail-warning">{t('settings.billing.paymentPastDuePleaseUpdate')}</p>
            )}
          </div>
        </div>

        {isSignedIn ? (
          /* Signed in: locked email + refresh + sign out */
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1 px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text">
                {billingEmail}
              </div>
              <button onClick={() => refreshSignedIn({ manual: true })} disabled={syncing || cooldownRemaining > 0}
                className="p-2 text-sm text-mail-text-muted hover:text-mail-accent-text rounded-lg hover:bg-mail-accent/10 transition-colors disabled:opacity-50"
                title={t('settings.billing.refreshSubscriptionStatus')}>
                {syncing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            <button
              onClick={() => setShowLogoutConfirm(true)}
              disabled={logoutLoading}
              className="flex items-center gap-1.5 text-xs font-medium text-mail-danger hover:opacity-80 transition-colors disabled:opacity-50"
            >
              <LogOut size={12} />
              {t('settings.billing.signOutPremiumDevice')}
            </button>
          </div>
        ) : accountEmails.length === 0 ? (
          <p className="text-xs text-mail-text-muted">
            {t('settings.billing.addEmailAccountFirstSign')}
          </p>
        ) : (
          /* Signed out: account dropdown + sign in */
          <div className="flex gap-2">
            <select
              value={selectedEmail}
              onChange={e => { setSelectedEmail(e.target.value); setSignInNotice(null); }}
              className="flex-1 min-w-0 px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text focus:outline-none focus:ring-1 focus:ring-mail-accent"
            >
              {accountEmails.map(email => (
                <option key={email} value={email}>{email}</option>
              ))}
            </select>
            <button onClick={handleSignIn} disabled={signInDisabled}
              className="min-w-[140px] px-4 py-2 text-sm font-medium bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
              {syncing ? <Loader size={14} className="animate-spin" /> : <CreditCard size={14} />}
              <span>{signInLabel}</span>
            </button>
          </div>
        )}
        {signInNotice && !isSignedIn && (
          <div className="mt-3 p-3 rounded-lg bg-mail-warning-tint border border-mail-warning/20">
            <p className="text-xs font-medium text-mail-warning">{signInNotice}</p>
            {selectedEmail && <p className="text-[11px] text-mail-text-muted mt-1">{t('settings.billing.checkedEmail', { email: selectedEmail })}</p>}
          </div>
        )}
        {syncError && <p className="text-xs text-mail-danger mt-2">{syncError}</p>}
        {billingLastChecked && isSignedIn && <p className="text-xs text-mail-text-muted mt-1">{t('settings.billing.lastSynced', { time: formatTime(billingLastChecked) })}</p>}
      </div>

      <PremiumFeatureList isPremium={isPremium} onNavigate={onNavigate} />

      {/* Early Bird Pricing — non-MAS only, it pitches the web subscription */}
      {!IS_APPSTORE_BUILD && !isPremium && (
        <div className="bg-mail-accent-tint border border-mail-accent/20 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">🐣</span>
            <h4 className="text-sm font-semibold text-mail-text">{t('settings.billing.earlyBirdFamilyPricing')}</h4>
          </div>
          <p className="text-xs text-mail-text-muted mb-3">
            {t('settings.billing.mailvaultEarlyAccessLockDiscounted')}
          </p>
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-mail-accent/10 text-mail-accent-text">
              <CheckCircle2 size={12} />
              <span>{t('settings.billing.earlyBirdRateLockedLife')}</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-mail-accent/10 text-mail-accent-text">
              <Monitor size={12} />
              <span>{t('settings.billing.up5DevicesPerSubscription')}</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-mail-accent/10 text-mail-accent-text">
              <Shield size={12} />
              <span>{t('settings.billing.fourteenDayFreeTrial')}</span>
            </div>
          </div>
        </div>
      )}

      {/* Plan Cards — data-driven from /api/billing/pricing.
          App Store builds must not offer a purchase path outside IAP, so every
          plan surface below is non-MAS only. Existing subscribers still sign in
          above and keep premium. */}
      {!IS_APPSTORE_BUILD && !isPremium && pricing?.plans && (() => {
        const monthlyPlan = pricing.plans.find(p => p.interval === 'month');
        const yearlyPlan = pricing.plans.find(p => p.interval === 'year');
        const mode = pricing.pricingMode;
        const showCurrencyHint = mode === 'fallback' || mode === 'adaptive';
        const hintText = mode === 'adaptive'
          ? t('settings.billing.pricesShownCheckoutConvertLocal', { pricing: pricing.currency.toUpperCase() })
          : mode === 'fallback'
          ? t('settings.billing.charged', { pricing: pricing.currency.toUpperCase() })
          : null;
        return (
          <>
            {showCurrencyHint && hintText && (
              <p className="text-xs text-mail-text-muted">{hintText}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              {monthlyPlan && (
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5 flex flex-col">
                  <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.billing.monthly')}</h4>
                  <div className="text-2xl font-bold text-mail-text mb-1">{monthlyPlan.formattedAmount}<span className="text-sm font-normal text-mail-text-muted">/mo</span></div>
                  <p className="text-xs text-mail-text-muted mb-4 flex-1">{t('settings.billing.cancelAnytime')}</p>
                  <button onClick={() => handleCheckout(monthlyPlan.planId)} disabled={checkoutLoading || !selectedEmail}
                    className="w-full py-2 text-sm font-semibold bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                    {checkoutLoading === 'monthly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    {t('common.upgrade')}
                  </button>
                </div>
              )}
              {yearlyPlan && (
                <div className="bg-mail-surface border-2 border-mail-accent rounded-xl p-5 flex flex-col relative">
                  {yearlyPlan.trialEligible && yearlyPlan.trialDays ? (
                    <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-mail-accent-fill text-white rounded-full">
                      {yearlyPlan.trialDays}-day free trial
                    </span>
                  ) : yearlyPlan.savingsPercent > 0 ? (
                    <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-mail-accent-fill text-white rounded-full">
                      {t('settings.billing.savePercent', { percent: yearlyPlan.savingsPercent })}
                    </span>
                  ) : null}
                  <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.billing.yearly')}</h4>
                  <div className="text-2xl font-bold text-mail-text mb-1">{yearlyPlan.formattedAmount}<span className="text-sm font-normal text-mail-text-muted">/yr</span></div>
                  <p className="text-xs text-mail-text-muted mb-4 flex-1">
                    {yearlyPlan.trialEligible && yearlyPlan.trialDays
                      ? t('settings.billing.daysFreeThenMonth', { yearlyPlan: yearlyPlan.trialDays, yearlyPlan2: yearlyPlan.monthlyEquivalent })
                      : `~${yearlyPlan.monthlyEquivalent}/month`}
                  </p>
                  <button onClick={() => handleCheckout(yearlyPlan.planId)} disabled={checkoutLoading || !selectedEmail}
                    className="w-full py-2 text-sm font-semibold bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                    {checkoutLoading === 'yearly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    {yearlyPlan.trialEligible && yearlyPlan.trialDays ? t('settings.billing.startFreeTrial') : t('common.upgrade')}
                  </button>
                </div>
              )}
            </div>
          </>
        );
      })()}
      {!IS_APPSTORE_BUILD && !isPremium && !pricing && pricingLoading && (
        <div className="flex items-center justify-center py-8 text-mail-text-muted text-xs gap-2">
          <Loader size={14} className="animate-spin" /> {t('settings.billing.loadingPlans')}
        </div>
      )}
      {/* Plans unreachable — never leave the user without a way to subscribe */}
      {!IS_APPSTORE_BUILD && !isPremium && !pricing && !pricingLoading && pricingError && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="text-sm font-semibold text-mail-text mb-1">{t('settings.billing.plansCouldNotLoaded')}</h4>
          <p className="text-xs text-mail-text-muted mb-3">{pricingError}</p>
          <div className="flex gap-2">
            <button onClick={() => loadPricing()}
              className="px-4 py-2 text-sm font-medium bg-mail-accent-fill text-white rounded-lg hover:bg-mail-accent/90 transition-colors flex items-center gap-1.5">
              <RefreshCw size={14} /> {t('common.retry')}
            </button>
            <button onClick={() => openInBrowser('https://mailvaultapp.com/pricing.html').catch(() => {})}
              className="px-4 py-2 text-sm font-medium border border-mail-border rounded-lg hover:border-mail-accent transition-colors text-mail-text flex items-center gap-1.5">
              <ExternalLink size={14} /> {t('settings.billing.viewPlansBrowser')}
            </button>
          </div>
        </div>
      )}

      {/* MAS, no subscription: say where premium comes from without pitching a
          purchase — otherwise the tab is a dead end for an existing subscriber. */}
      {IS_APPSTORE_BUILD && !isPremium && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <h4 className="text-sm font-semibold text-mail-text mb-1">{t('common.premium')}</h4>
          <p className="text-xs text-mail-text-muted">
            {t('settings.billing.premiumFeaturesComeMailvaultSubscription')}
          </p>
        </div>
      )}

      {checkoutError && <p className="text-xs text-mail-danger">{checkoutError}</p>}
      {/* emailError removed — dropdown prevents invalid input */}

      {/* Free alternative: share-to-unlock (non-MAS, non-premium only) */}
      {!IS_APPSTORE_BUILD && !isPremium && (
        <button
          onClick={() => useBackupStore.getState().setShareUnlock({ emailsBackedUp: 0 })}
          className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-mail-accent-text border border-mail-border rounded-lg hover:border-mail-accent transition-colors"
        >
          <Gift size={15} />
          Or unlock premium free — star &amp; share MailVault
        </button>
      )}

      {/* Manage Billing — the Stripe portal can change or restart a plan, which
          makes it a purchase mechanism App Review will not accept in-app. */}
      {!IS_APPSTORE_BUILD && billingProfile?.hasSubscription && customerId && (
        <button onClick={handleManageBilling}
          className="w-full py-2.5 text-sm font-medium bg-mail-surface border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors flex items-center justify-center gap-2 text-mail-text">
          <ExternalLink size={14} />
          {t('settings.billing.manageSubscription')}
        </button>
      )}

      {/* Active Devices */}
      {isPremium && activeClients.length > 0 && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-mail-text flex items-center gap-2">
              <Monitor size={16} /> {t('settings.billing.devices')}
            </h4>
            <span className="text-xs text-mail-text-muted">{activeClientCount} / {clientLimit}</span>
          </div>

          <div className="w-full h-1.5 bg-mail-border rounded-full mb-3">
            <div className={`h-full rounded-full transition-all ${activeClientCount >= clientLimit ? 'bg-mail-warning' : 'bg-mail-accent'}`}
              style={{ width: `${Math.min(100, (activeClientCount / clientLimit) * 100)}%` }} />
          </div>

          {replacedNotice && <p className="text-xs text-mail-warning mb-3">{replacedNotice}</p>}

          <div className="space-y-2">
            {activeClients.map(client => {
              const isCurrent = client.clientId === currentClientId;
              return (
                <div key={client.clientId} className={`flex items-center justify-between px-3 py-2 rounded-lg ${isCurrent ? 'bg-mail-accent/5 border border-mail-accent/20' : 'bg-mail-bg'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <Monitor size={14} className={isCurrent ? 'text-mail-accent-text flex-shrink-0' : 'text-mail-text-muted flex-shrink-0'} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-mail-text truncate">
                        {client.clientName || client.platform || 'Unknown device'}
                        {isCurrent && <span className="ml-1.5 text-[10px] text-mail-accent-text font-semibold">(this device)</span>}
                      </p>
                      <p className="text-[10px] text-mail-text-muted">
                        {[client.platform, client.appVersion && `v${client.appVersion}`].filter(Boolean).join(' · ')}
                        {client.lastSeenAt && ` · ${timeAgo(client.lastSeenAt)}`}
                      </p>
                    </div>
                  </div>
                  {!isCurrent && (
                    <button onClick={() => handleRemoveClient(client.clientId)}
                      disabled={removingClientId === client.clientId}
                      className="p-1 text-mail-text-muted hover:text-mail-danger rounded transition-colors flex-shrink-0"
                      title={t('settings.billing.removeDevice')}>
                      {removingClientId === client.clientId ? <Loader size={12} className="animate-spin" /> : <X size={12} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Feature Comparison */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="text-sm font-semibold text-mail-text mb-4">{t('settings.billing.whatSIncluded')}</h4>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-semibold text-mail-text-muted uppercase tracking-wide mb-2">{t('settings.billing.free')}</p>
            <ul className="space-y-2">
              {[[Mail, 'Read, search, compose emails'], [HardDrive, 'Local email caching & archive'],
                [Shield, 'Manual backup & export'], [CreditCard, 'Templates, notifications, security']].map(([Icon, text]) => (
                <li key={text} className="flex items-start gap-2 text-xs text-mail-text">
                  <Icon size={12} className="text-mail-text-muted mt-0.5 flex-shrink-0" />{text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-mail-accent-text uppercase tracking-wide mb-2">{t('common.premium')}</p>
            <ul className="space-y-2">
              {[[Clock, 'Scheduled automatic backups'], [CheckCircle2, 'Backup health & status management'],
                [ArrowLeftRight, 'Cross-account mailbox migration'], [Trash2, 'Auto-cleanup rules'],
                [ImageDown, 'Export emails as image or HTML']].map(([Icon, text]) => (
                <li key={text} className="flex items-start gap-2 text-xs text-mail-text">
                  <Icon size={12} className="text-mail-accent-text mt-0.5 flex-shrink-0" />{text}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-4 pt-3 border-t border-mail-border">
          <PremiumFeaturesLink />
        </div>
      </div>

      {/* Premium sign-out confirmation */}
      <ConfirmDialog
        isOpen={showLogoutConfirm}
        onClose={() => !logoutLoading && setShowLogoutConfirm(false)}
        onConfirm={handleBillingLogout}
        title={t('settings.billing.signOutPremium')}
        description="This will release the device seat and lock premium features on this device until you sign in again. Your subscription itself is not affected."
        confirmLabel="Sign Out"
        destructive
        loading={logoutLoading}
      />

      {/* Post-logout feedback */}
      {logoutToast && (
        <Toast
          message={logoutToast.message}
          type={logoutToast.type}
          onClose={() => setLogoutToast(null)}
        />
      )}
    </div>
  );
}
