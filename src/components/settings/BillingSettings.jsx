import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import {
  createCheckoutSession, createPortalSession, fetchSubscriptionStatus, fetchPricing,
  unregisterBillingClient, getClientInfo, openInBrowser,
  isBillingRateLimited, getBillingRateLimitedUntil, BillingRateLimitError,
} from '../../services/billingApi';
import {
  CreditCard,
  CheckCircle2,
  Loader,
  ExternalLink,
  RefreshCw,
  Clock,
  Shield,
  HardDrive,
  Mail,
  ArrowLeftRight,
  Trash2,
  Monitor,
  X,
} from 'lucide-react';

// Cooldown constants
const AUTO_REFRESH_COOLDOWN = 60_000;  // 60s for focus/mount
const MANUAL_REFRESH_COOLDOWN = 10_000; // 10s for button clicks
const STALE_THRESHOLD = 3600_000;       // 1h before mount auto-refresh

function formatDate(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function BillingSettings() {
  const billingEmail = useSettingsStore(s => s.billingEmail);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const billingLastChecked = useSettingsStore(s => s.billingLastChecked);
  const setBillingEmail = useSettingsStore(s => s.setBillingEmail);
  const setBillingProfile = useSettingsStore(s => s.setBillingProfile);

  const [emailInput, setEmailInput] = useState(billingEmail || '');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);      // transient: cleared on next successful refresh
  const [rateLimitMsg, setRateLimitMsg] = useState(null); // transient: cleared on next successful refresh or cooldown expiry
  const [showingCached, setShowingCached] = useState(false); // transient: true only while last request failed AND cached data exists
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);
  const [emailError, setEmailError] = useState(null);
  const [replacedNotice, setReplacedNotice] = useState(null);
  const [removingClientId, setRemovingClientId] = useState(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [pricing, setPricing] = useState(null); // { currency, currencySource, plans: [...] }
  const [pricingLoading, setPricingLoading] = useState(false);

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

  // Load client info once
  useEffect(() => { getClientInfo().then(info => { clientInfoRef.current = info; }); }, []);

  // Fetch pricing on mount (only when not premium — plan cards are hidden for premium users)
  // Pass email/customerId so server can check trial eligibility
  useEffect(() => {
    if (!isPremium && !pricing && !pricingLoading) {
      setPricingLoading(true);
      fetchPricing({ email: billingEmail, customerId })
        .then(setPricing).catch(() => {}).finally(() => setPricingLoading(false));
    }
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

  // Unified refresh: single-flight, cooldown-aware, uses unified endpoint
  const refreshStatus = useCallback(async (overrideEmail, { manual = false } = {}) => {
    const email = overrideEmail || billingEmail;
    const cid = billingProfile?.customerId;
    if (!email && !cid) return;

    // Cooldown check
    const cooldown = manual ? MANUAL_REFRESH_COOLDOWN : AUTO_REFRESH_COOLDOWN;
    if (Date.now() - lastRefreshRef.current < cooldown) return;
    if (isBillingRateLimited()) return;

    // Single-flight
    if (inflightRef.current && refreshPromiseRef.current) return refreshPromiseRef.current;

    inflightRef.current = true;
    setSyncing(true);
    setSyncError(null);

    const promise = (async () => {
      try {
        const clientInfo = clientInfoRef.current || await getClientInfo();
        clientInfoRef.current = clientInfo;

        // Single unified request: status + register if needed
        const result = await fetchSubscriptionStatus({
          customerId: cid, email,
          clientId: clientInfo.clientId,
          register: true,
          clientName: clientInfo.clientName,
          platform: clientInfo.platform,
          appVersion: clientInfo.appVersion,
          osVersion: clientInfo.osVersion,
        });

        setBillingProfile(result);
        lastRefreshRef.current = Date.now();

        // Success: clear ALL transient warnings immediately
        setSyncError(null);
        setRateLimitMsg(null);
        setShowingCached(false);

        if (result.customerEmail && result.customerEmail !== email) {
          setBillingEmail(result.customerEmail);
          setEmailInput(result.customerEmail);
        }
        if (result.replacedClient) {
          setReplacedNotice(`Replaced device "${result.replacedClient.clientName || result.replacedClient.clientId}" to make room.`);
          setTimeout(() => setReplacedNotice(null), 8000);
        }
      } catch (e) {
        if (e instanceof BillingRateLimitError) {
          setRateLimitMsg(e.message);
          setSyncError(null); // don't show both
        } else {
          setSyncError(e.message || 'Could not check billing status.');
          setRateLimitMsg(null);
        }
        // If we have cached billing data, indicate we're showing it as fallback
        const currentProfile = useSettingsStore.getState().billingProfile;
        if (currentProfile?.hasSubscription != null) {
          setShowingCached(true);
        }
      } finally {
        setSyncing(false);
        inflightRef.current = false;
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = promise;
    return promise;
  }, [billingEmail, billingProfile?.customerId, setBillingProfile, setBillingEmail]);

  // Focus refresh — only when Billing tab is visible and cooldown allows
  useEffect(() => {
    const onFocus = () => {
      if (!visibleRef.current) return;
      if (billingEmail || customerId) refreshStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [billingEmail, customerId, refreshStatus]);

  // Mount refresh — only if data is stale
  useEffect(() => {
    if ((billingEmail || customerId) && (!billingLastChecked || Date.now() - billingLastChecked > STALE_THRESHOLD)) {
      refreshStatus();
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

  const handleCheckStatus = () => {
    if (!emailInput.trim()) return;
    const email = emailInput.trim().toLowerCase();
    setBillingEmail(email);
    refreshStatus(email, { manual: true });
  };

  const handleCheckout = async (planId) => {
    setCheckoutError(null); setEmailError(null);
    const email = emailInput.trim().toLowerCase();
    if (!email) { setEmailError('Enter your email address to upgrade.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setEmailError('Please enter a valid email address.'); return; }
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

  const handleRemoveClient = async (clientId) => {
    setRemovingClientId(clientId);
    try {
      const result = await unregisterBillingClient({ customerId, email: billingEmail, clientId });
      setBillingProfile({ ...billingProfile, ...result });
    } catch (e) { setSyncError(e.message || 'Could not remove device.'); }
    finally { setRemovingClientId(null); }
  };

  const buttonDisabled = syncing || !emailInput.trim() || cooldownRemaining > 0;
  const buttonLabel = syncing ? 'Checking...'
    : cooldownRemaining > 0 ? `Wait ${cooldownRemaining}s`
    : 'Check Status';

  const statusLabel = !billingProfile?.hasSubscription ? 'Free'
    : billingProfile.status === 'active' ? `Premium ${billingProfile.interval === 'year' ? 'Yearly' : 'Monthly'}`
    : billingProfile.status === 'trialing' ? 'Premium (Trial)'
    : billingProfile.status === 'past_due' ? 'Premium (Past Due)'
    : billingProfile.status === 'canceled' ? 'Canceled'
    : billingProfile.status || 'Unknown';

  return (
    <div ref={rootRef} className="p-6 space-y-6 max-w-2xl">
      {/* Transient warning banners — cleared immediately on next successful refresh */}
      {rateLimitMsg && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500">
          {rateLimitMsg}
          {showingCached && <span className="block mt-1 text-mail-text-muted">Showing last known billing data.</span>}
        </div>
      )}
      {!rateLimitMsg && showingCached && (
        <div className="p-3 rounded-lg bg-mail-surface border border-mail-border text-xs text-mail-text-muted">
          Showing cached billing data. Will refresh automatically.
        </div>
      )}

      {/* Current Plan */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPremium ? 'bg-emerald-500/10' : 'bg-mail-accent/10'}`}>
            {isPremium ? <CheckCircle2 size={20} className="text-emerald-500" /> : <CreditCard size={20} className="text-mail-accent" />}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">{statusLabel}</h3>
            {billingProfile?.status === 'trialing' && billingProfile?.currentPeriodEnd && (
              <p className="text-xs text-emerald-500">
                Free trial ends {formatDate(billingProfile.currentPeriodEnd)} — yearly billing begins after.
              </p>
            )}
            {isPremium && billingProfile?.status !== 'trialing' && billingProfile?.currentPeriodEnd && (
              <p className="text-xs text-mail-text-muted">
                {billingProfile.cancelAtPeriodEnd
                  ? `Access until ${formatDate(billingProfile.currentPeriodEnd)}`
                  : `Renews ${formatDate(billingProfile.currentPeriodEnd)}`}
              </p>
            )}
            {billingProfile?.status === 'past_due' && (
              <p className="text-xs text-amber-500">Payment past due — please update your payment method.</p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <input
            type="email" value={emailInput}
            onChange={e => setEmailInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCheckStatus()}
            placeholder="your@email.com"
            className="flex-1 min-w-0 px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:outline-none focus:ring-1 focus:ring-mail-accent"
          />
          <button onClick={handleCheckStatus} disabled={buttonDisabled}
            className="min-w-[120px] px-4 py-2 text-sm font-medium bg-mail-accent/10 text-mail-accent rounded-lg hover:bg-mail-accent/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
            {syncing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span>{buttonLabel}</span>
          </button>
        </div>
        {syncError && <p className="text-xs text-mail-danger mt-2">{syncError}</p>}
        {billingLastChecked && <p className="text-xs text-mail-text-muted mt-1">Last checked: {new Date(billingLastChecked).toLocaleTimeString()}</p>}
      </div>

      {/* Plan Cards — data-driven from /api/billing/pricing */}
      {!isPremium && pricing?.plans && (() => {
        const monthlyPlan = pricing.plans.find(p => p.interval === 'month');
        const yearlyPlan = pricing.plans.find(p => p.interval === 'year');
        const mode = pricing.pricingMode;
        const showCurrencyHint = mode === 'fallback' || mode === 'adaptive';
        const hintText = mode === 'adaptive'
          ? `Prices shown in ${pricing.currency.toUpperCase()}. Checkout will convert to your local currency.`
          : mode === 'fallback'
          ? `Charged in ${pricing.currency.toUpperCase()}`
          : null;
        return (
          <>
            {showCurrencyHint && hintText && (
              <p className="text-xs text-mail-text-muted">{hintText}</p>
            )}
            <div className="grid grid-cols-2 gap-4">
              {monthlyPlan && (
                <div className="bg-mail-surface border border-mail-border rounded-xl p-5 flex flex-col">
                  <h4 className="text-sm font-semibold text-mail-text mb-1">Monthly</h4>
                  <div className="text-2xl font-bold text-mail-text mb-1">{monthlyPlan.formattedAmount}<span className="text-sm font-normal text-mail-text-muted">/mo</span></div>
                  <p className="text-xs text-mail-text-muted mb-4 flex-1">Cancel anytime</p>
                  <button onClick={() => handleCheckout(monthlyPlan.planId)} disabled={checkoutLoading || !emailInput.trim()}
                    className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                    {checkoutLoading === 'monthly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    Upgrade
                  </button>
                </div>
              )}
              {yearlyPlan && (
                <div className="bg-mail-surface border-2 border-mail-accent rounded-xl p-5 flex flex-col relative">
                  {yearlyPlan.trialEligible && yearlyPlan.trialDays ? (
                    <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-emerald-500 text-white rounded-full">
                      {yearlyPlan.trialDays}-day free trial
                    </span>
                  ) : yearlyPlan.savingsPercent > 0 ? (
                    <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-mail-accent text-white rounded-full">
                      Save {yearlyPlan.savingsPercent}%
                    </span>
                  ) : null}
                  <h4 className="text-sm font-semibold text-mail-text mb-1">Yearly</h4>
                  <div className="text-2xl font-bold text-mail-text mb-1">{yearlyPlan.formattedAmount}<span className="text-sm font-normal text-mail-text-muted">/yr</span></div>
                  <p className="text-xs text-mail-text-muted mb-4 flex-1">
                    {yearlyPlan.trialEligible && yearlyPlan.trialDays
                      ? `${yearlyPlan.trialDays} days free, then ~${yearlyPlan.monthlyEquivalent}/month`
                      : `~${yearlyPlan.monthlyEquivalent}/month`}
                  </p>
                  <button onClick={() => handleCheckout(yearlyPlan.planId)} disabled={checkoutLoading || !emailInput.trim()}
                    className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
                    {checkoutLoading === 'yearly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    {yearlyPlan.trialEligible && yearlyPlan.trialDays ? 'Start Free Trial' : 'Upgrade'}
                  </button>
                </div>
              )}
            </div>
          </>
        );
      })()}
      {!isPremium && !pricing && pricingLoading && (
        <div className="flex items-center justify-center py-8 text-mail-text-muted text-xs gap-2">
          <Loader size={14} className="animate-spin" /> Loading plans...
        </div>
      )}

      {checkoutError && <p className="text-xs text-mail-danger">{checkoutError}</p>}
      {emailError && <p className="text-xs text-mail-warning">{emailError}</p>}

      {/* Manage Billing */}
      {billingProfile?.hasSubscription && customerId && (
        <button onClick={handleManageBilling}
          className="w-full py-2.5 text-sm font-medium bg-mail-surface border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors flex items-center justify-center gap-2 text-mail-text">
          <ExternalLink size={14} />
          Manage Subscription
        </button>
      )}

      {/* Active Devices */}
      {isPremium && activeClients.length > 0 && (
        <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-mail-text flex items-center gap-2">
              <Monitor size={16} /> Devices
            </h4>
            <span className="text-xs text-mail-text-muted">{activeClientCount} / {clientLimit}</span>
          </div>

          <div className="w-full h-1.5 bg-mail-border rounded-full mb-3">
            <div className={`h-full rounded-full transition-all ${activeClientCount >= clientLimit ? 'bg-amber-500' : 'bg-mail-accent'}`}
              style={{ width: `${Math.min(100, (activeClientCount / clientLimit) * 100)}%` }} />
          </div>

          {replacedNotice && <p className="text-xs text-amber-500 mb-3">{replacedNotice}</p>}

          <div className="space-y-2">
            {activeClients.map(client => {
              const isCurrent = client.clientId === currentClientId;
              return (
                <div key={client.clientId} className={`flex items-center justify-between px-3 py-2 rounded-lg ${isCurrent ? 'bg-mail-accent/5 border border-mail-accent/20' : 'bg-mail-bg'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <Monitor size={14} className={isCurrent ? 'text-mail-accent flex-shrink-0' : 'text-mail-text-muted flex-shrink-0'} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-mail-text truncate">
                        {client.clientName || client.platform || 'Unknown device'}
                        {isCurrent && <span className="ml-1.5 text-[10px] text-mail-accent font-semibold">(this device)</span>}
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
                      title="Remove device">
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
        <h4 className="text-sm font-semibold text-mail-text mb-4">What's included</h4>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-semibold text-mail-text-muted uppercase tracking-wide mb-2">Free</p>
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
            <p className="text-xs font-semibold text-mail-accent uppercase tracking-wide mb-2">Premium</p>
            <ul className="space-y-2">
              {[[Clock, 'Scheduled automatic backups'], [CheckCircle2, 'Backup health & status management'],
                [ArrowLeftRight, 'Cross-account mailbox migration'], [Trash2, 'Auto-cleanup rules']].map(([Icon, text]) => (
                <li key={text} className="flex items-start gap-2 text-xs text-mail-text">
                  <Icon size={12} className="text-mail-accent mt-0.5 flex-shrink-0" />{text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
