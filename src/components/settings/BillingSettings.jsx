import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { createCheckoutSession, createPortalSession, fetchSubscriptionStatus, openInBrowser } from '../../services/billingApi';
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
} from 'lucide-react';

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
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
  const [checkoutLoading, setCheckoutLoading] = useState(null); // 'monthly' | 'yearly' | null
  const [checkoutError, setCheckoutError] = useState(null);
  const [emailError, setEmailError] = useState(null);

  const isPremium = hasPremiumAccess(billingProfile);
  const customerId = billingProfile?.customerId;

  // Auto-refresh on window focus when billing email is set
  useEffect(() => {
    const onFocus = () => {
      if ((billingEmail || customerId) && !syncing) {
        refreshStatus();
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [billingEmail, customerId]);

  // Auto-refresh on mount if stale (>1h)
  useEffect(() => {
    if ((billingEmail || customerId) && (!billingLastChecked || Date.now() - billingLastChecked > 3600_000)) {
      refreshStatus();
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!billingEmail && !customerId) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await fetchSubscriptionStatus({ customerId, email: billingEmail });
      setBillingProfile(result);
      if (result.customerEmail && result.customerEmail !== billingEmail) {
        setBillingEmail(result.customerEmail);
      }
    } catch (e) {
      setSyncError(e.message || 'Could not check billing status.');
    } finally {
      setSyncing(false);
    }
  }, [billingEmail, customerId, setBillingProfile, setBillingEmail]);

  const handleCheckStatus = async () => {
    if (!emailInput.trim()) return;
    setBillingEmail(emailInput.trim().toLowerCase());
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await fetchSubscriptionStatus({ customerId, email: emailInput.trim().toLowerCase() });
      setBillingProfile(result);
    } catch (e) {
      setSyncError(e.message || 'Could not check billing status.');
    } finally {
      setSyncing(false);
    }
  };

  const handleCheckout = async (priceType) => {
    setCheckoutError(null);
    setEmailError(null);
    const email = emailInput.trim().toLowerCase();
    if (!email) {
      setEmailError('Enter your email address to upgrade.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setCheckoutLoading(priceType);
    try {
      setBillingEmail(email);
      const { url, customerId: newCustomerId } = await createCheckoutSession(email, priceType);
      if (newCustomerId) {
        setBillingProfile({ ...billingProfile, customerId: newCustomerId, customerEmail: email });
      }
      try {
        await openInBrowser(url);
      } catch (browserErr) {
        setCheckoutError(browserErr.message || 'Could not open checkout in browser.');
      }
    } catch (e) {
      setCheckoutError(e.message || 'Could not start checkout.');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleManageBilling = async () => {
    try {
      const { url } = await createPortalSession(customerId, billingEmail);
      await openInBrowser(url);
    } catch (e) {
      setSyncError(e.message || 'Could not open billing portal.');
    }
  };

  // Status display
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

        {/* Billing Email */}
        <div className="flex gap-2">
          <input
            type="email"
            value={emailInput}
            onChange={e => setEmailInput(e.target.value)}
            placeholder="your@email.com"
            className="flex-1 px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:outline-none focus:ring-1 focus:ring-mail-accent"
          />
          <button
            onClick={handleCheckStatus}
            disabled={syncing || !emailInput.trim()}
            className="px-4 py-2 text-sm font-medium bg-mail-accent/10 text-mail-accent rounded-lg hover:bg-mail-accent/20 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {syncing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {syncing ? 'Checking...' : 'Check Status'}
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
            <button
              onClick={() => handleCheckout('monthly')}
              disabled={checkoutLoading || !emailInput.trim()}
              className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {checkoutLoading === 'monthly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Upgrade
            </button>
          </div>
          <div className="bg-mail-surface border-2 border-mail-accent rounded-xl p-5 flex flex-col relative">
            <span className="absolute -top-2.5 right-4 px-2 py-0.5 text-[10px] font-bold uppercase bg-mail-accent text-white rounded-full">Save 30%</span>
            <h4 className="text-sm font-semibold text-mail-text mb-1">Yearly</h4>
            <div className="text-2xl font-bold text-mail-text mb-1">$25<span className="text-sm font-normal text-mail-text-muted">/yr</span></div>
            <p className="text-xs text-mail-text-muted mb-4 flex-1">~$2.08/month</p>
            <button
              onClick={() => handleCheckout('yearly')}
              disabled={checkoutLoading || !emailInput.trim()}
              className="w-full py-2 text-sm font-semibold bg-mail-accent text-white rounded-lg hover:bg-mail-accent-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
            >
              {checkoutLoading === 'yearly' ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Upgrade
            </button>
          </div>
        </div>
      )}

      {/* Checkout/email errors */}
      {checkoutError && <p className="text-xs text-mail-danger">{checkoutError}</p>}
      {emailError && <p className="text-xs text-mail-warning">{emailError}</p>}

      {/* Manage Billing */}
      {billingProfile?.hasSubscription && customerId && (
        <button
          onClick={handleManageBilling}
          className="w-full py-2.5 text-sm font-medium bg-mail-surface border border-mail-border rounded-lg hover:bg-mail-surface-hover transition-colors flex items-center justify-center gap-2 text-mail-text"
        >
          <ExternalLink size={14} />
          Manage Subscription
        </button>
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
