import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import {
  createCheckoutSession, createPortalSession, fetchSubscriptionStatus,
  registerBillingClient, unregisterBillingClient, getClientInfo, openInBrowser,
} from '../../services/billingApi';
import {
  CreditCard,
  CheckCircle2,
  AlertCircle,
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

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function BillingSettings() {
  const billingEmail = useSettingsStore(s => s.billingEmail);
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const billingLastChecked = useSettingsStore(s => s.billingLastChecked);
  const setBillingEmail = useSettingsStore(s => s.setBillingEmail);
  const setBillingProfile = useSettingsStore(s => s.setBillingProfile);

  const [emailInput, setEmailInput] = useState(billingEmail || '');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [checkoutError, setCheckoutError] = useState(null);
  const [emailError, setEmailError] = useState(null);
  const [replacedNotice, setReplacedNotice] = useState(null); // transient notice when a device was replaced
  const [removingClientId, setRemovingClientId] = useState(null);

  const inflightRef = useRef(false);
  const refreshPromiseRef = useRef(null);
  const clientInfoRef = useRef(null);

  const isPremium = hasPremiumAccess(billingProfile);
  const customerId = billingProfile?.customerId;
  const activeClients = billingProfile?.activeClients || [];
  const clientLimit = billingProfile?.clientLimit || 5;
  const activeClientCount = billingProfile?.activeClientCount || 0;
  const currentClientId = billingProfile?.currentClientId || clientInfoRef.current?.clientId;

  // Load client info once on mount
  useEffect(() => {
    getClientInfo().then(info => { clientInfoRef.current = info; });
  }, []);

  // Unified refresh with client registration
  const refreshStatus = useCallback(async (overrideEmail) => {
    const email = overrideEmail || billingEmail;
    const cid = billingProfile?.customerId;
    if (!email && !cid) return;

    if (inflightRef.current && refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    inflightRef.current = true;
    setSyncing(true);
    setSyncError(null);

    const promise = (async () => {
      try {
        const clientInfo = clientInfoRef.current || await getClientInfo();
        clientInfoRef.current = clientInfo;

        // Fetch status with clientId so server updates last_seen_at
        const result = await fetchSubscriptionStatus({ customerId: cid, email, clientId: clientInfo.clientId });
        setBillingProfile(result);
        if (result.customerEmail && result.customerEmail !== email) {
          setBillingEmail(result.customerEmail);
          setEmailInput(result.customerEmail);
        }

        // Auto-register if premium but this client isn't registered yet
        if (result.premiumAccess && result.clientAccessGranted === false && result.customerId) {
          try {
            const regResult = await registerBillingClient({
              customerId: result.customerId,
              email,
              clientId: clientInfo.clientId,
              clientName: clientInfo.clientName,
              platform: clientInfo.platform,
              appVersion: clientInfo.appVersion,
              osVersion: clientInfo.osVersion,
            });
            setBillingProfile(regResult);
            if (regResult.replacedClient) {
              setReplacedNotice(`Replaced device "${regResult.replacedClient.client_name || regResult.replacedClient.client_id}" to make room.`);
              setTimeout(() => setReplacedNotice(null), 8000);
            }
          } catch (regErr) {
            console.warn('[BillingSettings] Auto-register failed:', regErr.message);
          }
        }
      } catch (e) {
        setSyncError(e.message || 'Could not check billing status.');
      } finally {
        setSyncing(false);
        inflightRef.current = false;
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = promise;
    return promise;
  }, [billingEmail, billingProfile?.customerId, setBillingProfile, setBillingEmail]);

  useEffect(() => {
    const onFocus = () => {
      if (billingEmail || customerId) refreshStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [billingEmail, customerId, refreshStatus]);

  useEffect(() => {
    if ((billingEmail || customerId) && (!billingLastChecked || Date.now() - billingLastChecked > 3600_000)) {
      refreshStatus();
    }
  }, []);

  const handleCheckStatus = () => {
    if (!emailInput.trim()) return;
    const email = emailInput.trim().toLowerCase();
    setBillingEmail(email);
    refreshStatus(email);
  };

  const handleCheckout = async (priceType) => {
    setCheckoutError(null);
    setEmailError(null);
    const email = emailInput.trim().toLowerCase();
    if (!email) { setEmailError('Enter your email address to upgrade.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setEmailError('Please enter a valid email address.'); return; }
    setCheckoutLoading(priceType);
    try {
      setBillingEmail(email);
      const { url, customerId: newCustomerId } = await createCheckoutSession(email, priceType);
      if (newCustomerId) setBillingProfile({ ...billingProfile, customerId: newCustomerId, customerEmail: email });
      try { await openInBrowser(url); } catch (browserErr) { setCheckoutError(browserErr.message || 'Could not open checkout in browser.'); }
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
    } catch (e) {
      setSyncError(e.message || 'Could not remove device.');
    } finally { setRemovingClientId(null); }
  };

  const statusLabel = !billingProfile?.hasSubscription ? 'Free'
    : billingProfile.status === 'active' ? `Premium ${billingProfile.interval === 'year' ? 'Yearly' : 'Monthly'}`
    : billingProfile.status === 'trialing' ? 'Premium (Trial)'
    : billingProfile.status === 'past_due' ? 'Premium (Past Due)'
    : billingProfile.status === 'canceled' ? 'Canceled'
    : billingProfile.status || 'Unknown';

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Current Plan */}
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isPremium ? 'bg-emerald-500/10' : 'bg-mail-accent/10'}`}>
            {isPremium ? <CheckCircle2 size={20} className="text-emerald-500" /> : <CreditCard size={20} className="text-mail-accent" />}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-mail-text">{statusLabel}</h3>
            {isPremium && billingProfile?.currentPeriodEnd && (
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
            type="email"
            value={emailInput}
            onChange={e => setEmailInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCheckStatus()}
            placeholder="your@email.com"
            className="flex-1 min-w-0 px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:outline-none focus:ring-1 focus:ring-mail-accent"
          />
          <button
            onClick={handleCheckStatus}
            disabled={syncing || !emailInput.trim()}
            className="min-w-[120px] px-4 py-2 text-sm font-medium bg-mail-accent/10 text-mail-accent rounded-lg hover:bg-mail-accent/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {syncing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span>{syncing ? 'Checking...' : 'Check Status'}</span>
          </button>
        </div>
        {syncError && <p className="text-xs text-mail-danger mt-2">{syncError}</p>}
        {billingLastChecked && <p className="text-xs text-mail-text-muted mt-1">Last checked: {new Date(billingLastChecked).toLocaleTimeString()}</p>}
      </div>

      {/* Plan Cards */}
      {!isPremium && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-mail-surface border border-mail-border rounded-xl p-5 flex flex-col">
            <h4 className="text-sm font-semibold text-mail-text mb-1">Monthly</h4>
            <div className="text-2xl font-bold text-mail-text mb-1">$3<span className="text-sm font-normal text-mail-text-muted">/mo</span></div>
            <p className="text-xs text-mail-text-muted mb-4 flex-1">Cancel anytime</p>
            <button onClick={() => handleCheckout('monthly')} disabled={checkoutLoading || !emailInput.trim()}
              className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
              {checkoutLoading === 'monthly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Upgrade
            </button>
          </div>
          <div className="bg-mail-surface border-2 border-mail-accent rounded-xl p-5 flex flex-col relative">
            <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-mail-accent text-white rounded-full">Save 30%</span>
            <h4 className="text-sm font-semibold text-mail-text mb-1">Yearly</h4>
            <div className="text-2xl font-bold text-mail-text mb-1">$25<span className="text-sm font-normal text-mail-text-muted">/yr</span></div>
            <p className="text-xs text-mail-text-muted mb-4 flex-1">~$2.08/month</p>
            <button onClick={() => handleCheckout('yearly')} disabled={checkoutLoading || !emailInput.trim()}
              className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5">
              {checkoutLoading === 'yearly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Upgrade
            </button>
          </div>
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
              <Monitor size={16} />
              Devices
            </h4>
            <span className="text-xs text-mail-text-muted">{activeClientCount} / {clientLimit}</span>
          </div>

          {/* Usage bar */}
          <div className="w-full h-1.5 bg-mail-border rounded-full mb-3">
            <div
              className={`h-full rounded-full transition-all ${activeClientCount >= clientLimit ? 'bg-amber-500' : 'bg-mail-accent'}`}
              style={{ width: `${Math.min(100, (activeClientCount / clientLimit) * 100)}%` }}
            />
          </div>

          {replacedNotice && (
            <p className="text-xs text-amber-500 mb-3">{replacedNotice}</p>
          )}

          <div className="space-y-2">
            {activeClients.map(client => {
              const isCurrent = client.client_id === currentClientId;
              return (
                <div key={client.client_id} className={`flex items-center justify-between px-3 py-2 rounded-lg ${isCurrent ? 'bg-mail-accent/5 border border-mail-accent/20' : 'bg-mail-bg'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <Monitor size={14} className={isCurrent ? 'text-mail-accent flex-shrink-0' : 'text-mail-text-muted flex-shrink-0'} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-mail-text truncate">
                        {client.client_name || client.platform || 'Unknown device'}
                        {isCurrent && <span className="ml-1.5 text-[10px] text-mail-accent font-semibold">(this device)</span>}
                      </p>
                      <p className="text-[10px] text-mail-text-muted">
                        {[client.platform, client.app_version && `v${client.app_version}`].filter(Boolean).join(' · ')}
                        {client.last_seen_at && ` · ${timeAgo(client.last_seen_at)}`}
                      </p>
                    </div>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => handleRemoveClient(client.client_id)}
                      disabled={removingClientId === client.client_id}
                      className="p-1 text-mail-text-muted hover:text-mail-danger rounded transition-colors flex-shrink-0"
                      title="Remove device"
                    >
                      {removingClientId === client.client_id ? <Loader size={12} className="animate-spin" /> : <X size={12} />}
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
              {[
                [Mail, 'Read, search, compose emails'],
                [HardDrive, 'Local email caching & archive'],
                [Shield, 'Manual backup & export'],
                [CreditCard, 'Templates, notifications, security'],
              ].map(([Icon, text]) => (
                <li key={text} className="flex items-start gap-2 text-xs text-mail-text">
                  <Icon size={12} className="text-mail-text-muted mt-0.5 flex-shrink-0" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-mail-accent uppercase tracking-wide mb-2">Premium</p>
            <ul className="space-y-2">
              {[
                [Clock, 'Scheduled automatic backups'],
                [CheckCircle2, 'Backup health & status management'],
                [ArrowLeftRight, 'Cross-account mailbox migration'],
                [Trash2, 'Auto-cleanup rules'],
              ].map(([Icon, text]) => (
                <li key={text} className="flex items-start gap-2 text-xs text-mail-text">
                  <Icon size={12} className="text-mail-accent mt-0.5 flex-shrink-0" />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
