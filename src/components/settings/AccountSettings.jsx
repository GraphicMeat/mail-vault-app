import { Button } from '../ui/Button';
import React, { useState, useEffect, useRef } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore, AVATAR_COLORS, getAccountInitial, getAccountColor, hasPremiumAccess } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { getOAuth2AuthUrl, exchangeOAuth2Code, ensureSentMailbox, fetchMailboxes } from '../../services/api';
import { findSentMailboxPath } from '../../utils/sentFolder';
import { suggestSendAsAddresses } from '../../utils/sendAsSuggestions';
import { isFastmailAccount } from '../AccountModal.jsx';
import { SendAsVerifyModal } from './SendAsVerifyModal';
import { Send } from 'lucide-react';
import { ToggleSwitch } from './ToggleSwitch';
import { SettingsTabs } from './SettingsTabs';
import { AccountReorderList } from './AccountReorderList';
import '../../styles/account-settings-navigation.css';
import { RichTextEditor, textToHtml, htmlToText } from '../RichTextEditor';
import { Toast } from '../Toast';
import {
  User,
  Mail,
  FileText,
  Shield,
  Check,
  Trash2,
  Loader,
  RefreshCw,
  Key,
  AlertCircle,
  Plus,
  Eye,
  EyeOff,
  Server,
} from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';
import { T } from '../../i18n/T.jsx';

function SavedBadge({ visible }) {
  const t = useT();
  return (
    <AnimatePresence>
      {visible && (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="ml-auto flex items-center gap-1 text-xs font-normal text-mail-text-muted"
        >
          <Check size={13} />
          {t('settings.accounts.saved')}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

export function AccountSettings({ accounts, onAddAccount, initialAccountId, initialSection = 'profile', onSectionChange }) {
  const t = useT();
  const { removeAccount, activeAccountId, activeMailbox, connectionStatus, connectionError, connectionErrorType, activateAccount } = useAccountStore();
  const {
    signatures,
    setSignature,
    getSignature,
    displayNames,
    setDisplayName,
    getDisplayName,
    setSendAsAddress,
    getSendAsAddress,
    getOrderedAccounts,
    setAccountOrder,
    accountColors,
    setAccountColor,
    clearAccountColor,
    hiddenAccounts,
    setAccountHidden,
    isAccountHidden,
    openChangeServer,
  } = useSettingsStore();

  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || accounts[0]?.id || null);
  const [section, setSection] = useState(['profile', 'connection', 'advanced'].includes(initialSection) ? initialSection : 'profile');
  const panelRef = useRef(null);
  const [signatureHtml, setSignatureHtml] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [sendAs, setSendAs] = useState('');
  const [sendAsSuggestions, setSendAsSuggestions] = useState([]);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const autoSaveTimer = useRef(null);
  const autoSavedTimer = useRef(null);
  const [editingPassword, setEditingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [oauthReconnecting, setOauthReconnecting] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [billingWarning, setBillingWarning] = useState(null);
  const [accountMailboxes, setAccountMailboxes] = useState([]);
  const [sentOverride, setSentOverride] = useState('');
  const [savingSent, setSavingSent] = useState(false);
  const [autoCreatingSent, setAutoCreatingSent] = useState(false);

  const orderedAccounts = getOrderedAccounts(accounts);
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const isActiveAccount = selectedAccountId === activeAccountId;
  const hasConnectionError = isActiveAccount && connectionStatus === 'error';
  const needsSignIn = hasConnectionError && ['passwordMissing', 'oauthExpired'].includes(connectionErrorType);
  const needsPassword = needsSignIn && selectedAccount?.authType !== 'oauth2';
  const isHidden = !!hiddenAccounts[selectedAccountId];
  const statusLabel = isHidden ? t('settings.accounts.accountHidden')
    : needsPassword ? t('settings.accounts.passwordRequired')
    : needsSignIn ? t('settings.accounts.reconnectRequired')
    : hasConnectionError ? t(connectionErrorType === 'offline' ? 'sidebar.noInternet'
      : connectionErrorType === 'timeout' ? 'sidebar.timedOut'
      : connectionErrorType === 'outlookOAuth' ? 'sidebar.microsoftIssue'
      : 'settings.accounts.connectionFailed')
    : isActiveAccount && connectionStatus === 'connected' ? t('settings.accounts.connected')
    : isActiveAccount && connectionStatus === 'connecting' ? t('sidebar.connecting')
    : isActiveAccount ? t('settings.accounts.disconnected')
    : t('settings.accounts.inactiveStatus');
  // Shape check only — whether the server will accept it is what Verify answers.
  const sendAsIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendAs.trim());
  const invoke = window.__TAURI__?.core?.invoke;

  const changeSection = value => {
    setSection(value);
    onSectionChange?.(value);
  };

  useEffect(() => {
    if (['profile', 'connection', 'advanced'].includes(initialSection)) setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (initialAccountId && accounts.some(account => account.id === initialAccountId)) setSelectedAccountId(initialAccountId);
  }, [initialAccountId]);

  useEffect(() => {
    if (!accounts.some(account => account.id === selectedAccountId)) setSelectedAccountId(accounts[0]?.id || null);
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    const panel = panelRef.current?.querySelector('[role="tabpanel"]');
    if (panel) panel.scrollTop = 0;
  }, [section, selectedAccountId]);

  // Load signature and display name when account changes
  useEffect(() => {
    if (selectedAccountId) {
      const sig = getSignature(selectedAccountId);
      setSignatureHtml(sig.html || textToHtml(sig.text || ''));
      setAccountDisplayName(getDisplayName(selectedAccountId) || '');
      setSendAs(getSendAsAddress(selectedAccountId) || '');
      setShowRemoveConfirm(false);
      setEditingPassword(false);
      setNewPassword('');
      setVerifyOpen(false);
    }
  }, [selectedAccountId]);

  // Alias candidates mined from this account's cached Sent headers. Providers
  // give us no alias list under the credentials we hold, so these are
  // suggestions — the SMTP server stays the authority (that's what Verify is
  // for).
  useEffect(() => {
    let cancelled = false;
    setSendAsSuggestions([]);
    if (!selectedAccount) return undefined;
    suggestSendAsAddresses(selectedAccount).then(list => {
      if (!cancelled) setSendAsSuggestions(list);
    });
    return () => { cancelled = true; };
  }, [selectedAccountId]);

  // Autosave display name + signature — no Save button
  const pendingEdits = useRef({ html: '', name: '', sendAs: '' });
  pendingEdits.current = { html: signatureHtml, name: accountDisplayName, sendAs };

  const persistAccountSettings = (accountId, rawHtml, name, sendAsValue = '') => {
    if (!accountId) return;
    const sig = getSignature(accountId);
    const text = htmlToText(rawHtml);
    const html = text ? rawHtml : '';
    const nameChanged = (getDisplayName(accountId) || '') !== name;
    const sigChanged = (sig.html || '') !== html || (sig.text || '') !== text;
    const trimmedSendAs = (sendAsValue || '').trim();
    const sendAsChanged = (getSendAsAddress(accountId) || '') !== trimmedSendAs;
    if (!nameChanged && !sigChanged && !sendAsChanged) return;

    if (sendAsChanged) setSendAsAddress(accountId, trimmedSendAs);
    if (nameChanged) setDisplayName(accountId, name);
    if (sigChanged) {
      setSignature(accountId, {
        ...sig,
        html,
        text,
        // first content on a never-configured signature turns it on
        enabled: sig.enabled || (!sig.html && !sig.text && !!text),
      });
    }
    setAutoSaved(true);
    clearTimeout(autoSavedTimer.current);
    autoSavedTimer.current = setTimeout(() => setAutoSaved(false), 1500);
  };

  useEffect(() => {
    if (!selectedAccountId) return;
    const accountId = selectedAccountId;
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(
      () => persistAccountSettings(accountId, signatureHtml, accountDisplayName, sendAs),
      400
    );
    return () => clearTimeout(autoSaveTimer.current);
  }, [signatureHtml, accountDisplayName, sendAs, selectedAccountId]);

  // Flush pending edits when switching accounts or leaving Settings
  useEffect(() => {
    const accountId = selectedAccountId;
    return () => {
      clearTimeout(autoSaveTimer.current);
      persistAccountSettings(
        accountId,
        pendingEdits.current.html,
        pendingEdits.current.name,
        pendingEdits.current.sendAs
      );
    };
  }, [selectedAccountId]);

  useEffect(() => () => clearTimeout(autoSavedTimer.current), []);

  // Load mailbox tree + current Sent override for the selected account
  useEffect(() => {
    if (!selectedAccountId) return;
    setSentOverride(selectedAccount?.sentFolderOverride || '');
    let cancelled = false;
    (async () => {
      const { activeAccountId, mailboxes } = useMailStore.getState();
      let list = activeAccountId === selectedAccountId && mailboxes?.length ? mailboxes : null;
      if (!list) {
        const { getCachedMailboxes } = await import('../../services/db');
        list = await getCachedMailboxes(selectedAccountId).catch(() => []);
      }
      if (!cancelled) setAccountMailboxes(list || []);
    })();
    return () => { cancelled = true; };
  }, [selectedAccountId, selectedAccount?.sentFolderOverride]);

  const flattenedMailboxes = React.useMemo(() => {
    const out = [];
    const walk = (boxes, depth = 0) => {
      for (const b of boxes || []) {
        if (!b.noselect) out.push({ path: b.path, label: `${'\u2003'.repeat(depth)}${b.name || b.path}` });
        if (b.children?.length) walk(b.children, depth + 1);
      }
    };
    walk(accountMailboxes);
    return out;
  }, [accountMailboxes]);

  const autoDetectedSentPath = React.useMemo(
    () => findSentMailboxPath(accountMailboxes, null),
    [accountMailboxes]
  );

  const handleSaveSentFolder = async () => {
    if (!selectedAccount) return;
    setSavingSent(true);
    try {
      const nextOverride = sentOverride || null;
      const updated = { ...selectedAccount, sentFolderOverride: nextOverride };
      const { saveAccount } = await import('../../services/db');
      await saveAccount(updated);
      useMailStore.setState(s => ({
        accounts: (s.accounts || []).map(a => a.id === selectedAccountId ? { ...a, sentFolderOverride: nextOverride } : a),
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save Sent folder:', err);
      alert(t('settings.accounts.couldSaveSentFolderReconnect') + (err.message || err));
    } finally {
      setSavingSent(false);
    }
  };

  const handleAutoCreateSent = async () => {
    if (!selectedAccount) return;
    setAutoCreatingSent(true);
    try {
      const path = await ensureSentMailbox(selectedAccount);
      if (!path) throw new Error('Server returned empty path');
      const updated = { ...selectedAccount, sentFolderOverride: path };
      const { saveAccount, saveMailboxes } = await import('../../services/db');
      await saveAccount(updated);
      // Refresh mailbox tree so a newly-created folder becomes visible
      try {
        const fresh = await fetchMailboxes(updated);
        if (Array.isArray(fresh) && fresh.length) {
          await saveMailboxes?.(selectedAccountId, fresh).catch(() => {});
          setAccountMailboxes(fresh);
          useMailStore.setState(s => ({
            mailboxes: s.activeAccountId === selectedAccountId ? fresh : s.mailboxes,
          }));
        }
      } catch {}
      useMailStore.setState(s => ({
        accounts: (s.accounts || []).map(a => a.id === selectedAccountId ? { ...a, sentFolderOverride: path } : a),
      }));
      setSentOverride(path);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Auto-create Sent folder failed:', err);
      alert(t('settings.accounts.couldFindCreateSentFolder') + (err.message || err));
    } finally {
      setAutoCreatingSent(false);
    }
  };

  // Reconnect OAuth2 account — preserves Graph transport, custom client/tenant
  const handleOAuth2Reconnect = async () => {
    if (!selectedAccountId) return;
    setOauthReconnecting(true);

    try {
      const account = accounts.find(a => a.id === selectedAccountId);
      const provider = account?.oauth2Provider || 'microsoft';
      const useGraph = account?.oauth2Transport === 'graph';
      const { authUrl, state } = await getOAuth2AuthUrl(
        account?.email,
        provider,
        account?.oauth2CustomClientId,
        account?.oauth2TenantId,
        useGraph
      );

      if (invoke) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      const tokenData = await exchangeOAuth2Code(state);

      const { saveAccount } = await import('../../services/db');
      if (account) {
        // Spread all existing account fields to preserve oauth2Transport,
        // oauth2Provider, oauth2CustomClientId, oauth2TenantId, etc.
        await saveAccount({
          ...account,
          oauth2AccessToken: tokenData.accessToken,
          oauth2RefreshToken: tokenData.refreshToken,
          oauth2ExpiresAt: tokenData.expiresAt,
        });
      }

      const { init } = useMailStore.getState();
      await init();

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('OAuth2 reconnect failed:', error);
      alert(t('settings.accounts.couldReconnectAccountCheckPassword') + (error.message || error));
    } finally {
      setOauthReconnecting(false);
    }
  };

  // Update account password
  const handleUpdatePassword = async () => {
    if (!selectedAccountId || !newPassword.trim()) return;

    try {
      // Store the new password in keychain
      if (invoke) {
        await invoke('store_password', {
          accountId: selectedAccountId,
          password: newPassword
        });
      }

      // Re-save to db to trigger password storage
      const account = accounts.find(a => a.id === selectedAccountId);
      if (account) {
        const { saveAccount } = await import('../../services/db');
        await saveAccount({ ...account, password: newPassword });
      }

      // Reinitialize the mail store to pick up the new password
      const { init } = useMailStore.getState();
      await init();

      setEditingPassword(false);
      setNewPassword('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Failed to update password:', error);
      alert(t('settings.accounts.couldSaveNewPasswordKeychain') + error);
    }
  };

  return (
    <div className="account-settings-layout">
      {/* Account List - Left Column */}
      <div className="account-settings-list">
        <div className="p-4">
          <div className="text-sm font-medium text-mail-text-muted mb-3">
            {t('settings.accounts.accounts')}
          </div>
          {accounts.length === 0 ? (
            <div className="text-center py-8 text-mail-text-muted">
              <Mail size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">{t('common.noAccountsConfigured')}</p>
            </div>
          ) : (
            <AccountReorderList accounts={orderedAccounts} selectedAccountId={selectedAccountId} onReorder={setAccountOrder}>
              {account => (
                  <button type="button" className="account-settings-account-button"
                    aria-pressed={account.id === selectedAccountId} onClick={() => setSelectedAccountId(account.id)}>
                  <div
                    className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-white text-sm font-bold select-none${hiddenAccounts[account.id] ? ' opacity-40' : ''}`}
                    style={{ backgroundColor: getAccountColor(accountColors, account) }}
                  >
                    {getAccountInitial(account, getDisplayName(account.id))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-mail-text truncate flex items-center gap-1.5">
                      {getDisplayName(account.id) || account.name || account.email?.split('@')[0] || 'Unknown'}
                      {account.authType === 'oauth2' && (
                        <Shield size={12} className="text-mail-accent-text flex-shrink-0" />
                      )}
                      {hiddenAccounts[account.id] && (
                        <EyeOff size={12} className="text-mail-text-muted flex-shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-mail-text-muted truncate">
                      {account.email}
                    </div>
                  </div>
                  </button>
              )}
            </AccountReorderList>
          )}
          {onAddAccount && (
            <button
              onClick={onAddAccount}
              className="w-full mt-3 flex items-center justify-center gap-2 p-2.5 text-sm text-mail-text-muted
                        hover:text-mail-text hover:bg-mail-surface-hover border border-dashed border-mail-border
                        rounded-lg transition-all"
            >
              <Plus size={16} />
              {t('settings.accounts.addAccount')}
            </button>
          )}
        </div>
      </div>

      {/* Account Settings - Right Column */}
      <div ref={panelRef} className="account-settings-detail">
        {selectedAccount ? (
          <>
            <header className="account-settings-identity">
              <div className="account-settings-identity-line">
                <span className="account-settings-avatar" aria-hidden="true"
                  style={{ backgroundColor: getAccountColor(accountColors, selectedAccount) }}>
                  {getAccountInitial(selectedAccount, getDisplayName(selectedAccountId))}
                </span>
                <div className="account-settings-identity-copy">
                  <h3>{getDisplayName(selectedAccountId) || selectedAccount.name || selectedAccount.email}</h3>
                  <p>{selectedAccount.email}</p>
                </div>
                <SavedBadge visible={autoSaved || saved} />
              </div>
              <div role="status" className={`account-settings-status ${hasConnectionError && !isHidden ? 'account-settings-status-error' : ''}`}>
                {hasConnectionError && !isHidden ? <AlertCircle size={15} aria-hidden="true" />
                  : isActiveAccount && connectionStatus === 'connected' && !isHidden ? <Check size={15} aria-hidden="true" />
                  : isHidden ? <EyeOff size={15} aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}
                <span>{statusLabel}</span>
                {hasConnectionError && !isHidden && <Button variant="subtle" size="sm" disabled={oauthReconnecting}
                  onClick={() => {
                    if (needsPassword) { changeSection('connection'); setEditingPassword(true); }
                    else if (needsSignIn) handleOAuth2Reconnect();
                    else activateAccount(selectedAccountId, activeMailbox || 'INBOX');
                  }}>
                  {oauthReconnecting ? t('settings.accounts.reconnecting') : needsPassword ? t('settings.accounts.enterPassword')
                    : needsSignIn ? t('settings.accounts.reconnect') : t('common.retry')}
                </Button>}
              </div>
            </header>
            <SettingsTabs value={section} onChange={changeSection} label={t('settings.accounts.preferences')}
              tabs={[
                { id: 'profile', label: t('settings.accounts.sectionProfile') },
                { id: 'connection', label: t('settings.accounts.sectionConnection') },
                { id: 'advanced', label: t('settings.accounts.sectionAdvanced') },
              ]}>
              <p className="account-settings-section-intro">{t(`settings.accounts.${section}Intro`)}</p>
              {section === 'profile' && <>
            {/* Account Info */}
            <div className="settings-section">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <User size={18} className="text-mail-accent-text" />
                {t('settings.accounts.accountSettings')}
              </h4>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {isFastmailAccount(selectedAccount) ? t('account.loginAddress') : t('account.emailAddress')}
                  </label>
                  <input aria-label={isFastmailAccount(selectedAccount) ? t('account.loginAddress') : t('account.emailAddress')}
                    type="text"
                    value={selectedAccount.email}
                    disabled
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text-muted cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {t('settings.accounts.displayName')}
                  </label>
                  <p className="text-sm text-mail-text-muted mb-2">
                    {t('settings.accounts.nameShownFromFieldSending')}
                  </p>
                  <input aria-label={t('settings.accounts.displayName')}
                    type="text"
                    value={accountDisplayName}
                    onChange={(e) => setAccountDisplayName(e.target.value)}
                    placeholder={t('settings.accounts.johnDoe')}
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text placeholder-mail-text-muted
                              focus:border-mail-accent transition-all"
                  />
                </div>

                {/* Send mail as */}
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {t('settings.accounts.sendMail')}
                  </label>
                  <p className="text-sm text-mail-text-muted mb-2">
                    <T k="settings.accounts.addressUsedFromHeaderSending"
                       vars={{ email: selectedAccount.email }}
                       parts={[(s) => <span className="font-mono">{s}</span>]} />
                  </p>
                  <div className="flex items-center gap-2">
                    <input aria-label={t('settings.accounts.sendMail')}
                      type="email"
                      value={sendAs}
                      onChange={(e) => setSendAs(e.target.value)}
                      placeholder={selectedAccount.email}
                      list={`send-as-suggestions-${selectedAccountId}`}
                      data-testid="send-as-input"
                      className="flex-1 min-w-0 px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent transition-all"
                    />
                    <datalist id={`send-as-suggestions-${selectedAccountId}`}>
                      {sendAsSuggestions.map(s => (
                        <option key={s.address} value={s.address} />
                      ))}
                    </datalist>
                    <button
                      onClick={() => setVerifyOpen(true)}
                      disabled={!sendAsIsValid}
                      data-testid="send-as-verify-btn"
                      className="px-4 py-2.5 rounded-lg text-sm border border-mail-border
                                text-mail-text hover:bg-mail-surface-hover transition-colors
                                disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      title={sendAsIsValid ? t('settings.accounts.sendTestMessageAddress') : t('settings.accounts.enterValidAddressFirst')}
                    >
                      {t('settings.accounts.verify')}
                    </button>
                  </div>
                  {sendAsSuggestions.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap mt-2" data-testid="send-as-suggestions">
                      <span className="text-xs text-mail-text-muted">{t('settings.accounts.veSent')}</span>
                      {sendAsSuggestions.map(s => (
                        <button
                          key={s.address}
                          onClick={() => setSendAs(s.address)}
                          className="text-xs font-mono px-2 py-1 rounded-md border border-mail-border
                                    text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover
                                    transition-colors"
                          title={t('settings.accounts.haveSentAddressBefore')}
                        >
                          {s.address}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            </div>

            {/* Signature */}
            <div className="settings-section">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <FileText size={18} className="text-mail-accent-text" />
                {t('settings.accounts.emailSignature')}
              </h4>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-mail-text">{t('settings.accounts.enableSignature')}</div>
                    <div className="text-sm text-mail-text-muted">
                      {t('settings.accounts.automaticallyAddOutgoingEmails')}
                    </div>
                  </div>
                  <ToggleSwitch
                    label={t('settings.accounts.enableSignature')} active={getSignature(selectedAccountId).enabled}
                    onClick={() => {
                      const sig = getSignature(selectedAccountId);
                      setSignature(selectedAccountId, { ...sig, enabled: !sig.enabled });
                    }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {t('settings.accounts.signatureContent')}
                  </label>
                  <div className="flex h-52 rounded-lg border border-mail-border overflow-hidden">
                    <RichTextEditor
                      content={signatureHtml}
                      onUpdate={(html) => setSignatureHtml(html)}
                      placeholder={t('settings.accounts.bestRegardsJohnDoe')}
                    />
                  </div>
                  <p className="text-xs text-mail-text-muted mt-2">
                    {t('settings.accounts.boldItalicLinksListsSupported')}
                  </p>
                </div>
              </div>
            </div>

              </>}
              {section === 'connection' && <>
                {hasConnectionError && connectionError && (
                  <details className="account-settings-error-details" key={selectedAccountId}>
                    <summary>{t('settings.accounts.technicalDetails')}</summary>
                    <p>{connectionError}</p>
                  </details>
                )}
            {/* Password / Authentication */}
            <div className="settings-section">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <Key size={18} className="text-mail-accent-text" />
                {t('settings.accounts.authentication')}
              </h4>

              {/* Auth type badge */}
              <div className="flex items-center gap-2 mb-4">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-mail-accent-tint text-mail-accent-text">
                  {selectedAccount.authType === 'oauth2' ? (
                    <><Shield size={12} /> {t('settings.accounts.providerOauth2', { provider: selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft' })}</>
                  ) : (
                    <><Key size={12} /> {t('settings.accounts.password')}</>
                  )}
                </span>
              </div>

              {/* OAuth2 account */}
              {selectedAccount.authType === 'oauth2' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-mail-text">{t('settings.accounts.providerAccount', { provider: selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft' })}</div>
                      <div className="text-sm text-mail-text-muted">
                        {t('settings.accounts.authenticatedViaOauth2TokensRefresh')}
                      </div>
                    </div>
                    <button
                      onClick={handleOAuth2Reconnect}
                      disabled={oauthReconnecting}
                      className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                text-mail-text rounded-lg transition-colors flex items-center gap-2
                                disabled:opacity-50"
                    >
                      {oauthReconnecting ? (
                        <Loader size={16} className="animate-spin" />
                      ) : (
                        <RefreshCw size={16} />
                      )}
                      {oauthReconnecting ? t('settings.accounts.reconnecting') : t('settings.accounts.reconnect')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Password auth */}
                  {editingPassword ? (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-mail-text mb-2">
                          {t('settings.accounts.newPassword')}
                        </label>
                        <input aria-label={t('settings.accounts.newPassword')}
                          type="password"
                          autoFocus
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={t('settings.accounts.enterEmailPassword')}
                          className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-mail-text placeholder-mail-text-muted
                                    focus:border-mail-accent transition-all"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleUpdatePassword}
                          disabled={!newPassword.trim()}
                          className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover
                                    text-white rounded-lg transition-colors disabled:opacity-50"
                        >
                          {t('settings.accounts.savePassword')}
                        </button>
                        <button
                          onClick={() => {
                            setEditingPassword(false);
                            setNewPassword('');
                          }}
                          className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                    text-mail-text rounded-lg transition-colors"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-mail-text">{t('settings.accounts.password')}</div>
                        <div className="text-sm text-mail-text-muted">
                          {selectedAccount.password ? t('settings.accounts.storedSecurelySystemKeychain') : t('settings.accounts.configured')}
                        </div>
                      </div>
                      <Button variant="subtle"
                        onClick={() => setEditingPassword(true)}
                      >
                        <Key size={16} />
                        {selectedAccount.password ? t('settings.accounts.update') : t('settings.accounts.setPassword')}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Mail Server (password / IMAP accounts only) */}
            {selectedAccount.authType !== 'oauth2' && (
              <div className="settings-section">
                <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                  <Server size={18} className="text-mail-accent-text" />
                  {t('settings.accounts.mailServer')}
                </h4>

                <p className="text-sm text-mail-text-muted mb-4">
                  {t('settings.accounts.changedHostingKeptSameAddress')}
                </p>

                <div className="flex items-center justify-between">
                  <div className="text-sm text-mail-text-muted space-y-0.5">
                    <div>
                      {t('settings.accounts.imap')} <code className="text-mail-text">{selectedAccount.imapHost || '—'}:{selectedAccount.imapPort || 993}</code>
                      {selectedAccount.imapSecurity && selectedAccount.imapSecurity !== 'ssl' && (
                        <span className="ml-1">({selectedAccount.imapSecurity.toUpperCase()})</span>
                      )}
                    </div>
                    <div>{t('settings.accounts.smtp')} <code className="text-mail-text">{selectedAccount.smtpHost || '—'}:{selectedAccount.smtpPort || 587}</code></div>
                  </div>
                  <button
                    onClick={() => openChangeServer(selectedAccountId)}
                    className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border text-mail-text
                              rounded-lg transition-colors flex items-center gap-2 text-sm"
                  >
                    <Server size={16} />
                    {t('settings.accounts.changeServer')}
                  </button>
                </div>
              </div>
            )}

            {/* Sent Folder */}
            <div className="settings-section">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <Send size={18} className="text-mail-accent-text" />
                {t('settings.accounts.sentFolder')}
              </h4>

              <p className="text-sm text-mail-text-muted mb-4">
                {t('settings.accounts.mailvaultAutoDetectsSentFolder')}
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {t('settings.accounts.sentFolder2')}
                  </label>
                  <select aria-label={t('settings.accounts.sentFolder2')}
                    value={sentOverride}
                    onChange={(e) => setSentOverride(e.target.value)}
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text focus:border-mail-accent transition-all"
                  >
                    <option value="">
                      {autoDetectedSentPath ? t('settings.accounts.autoDetectCurrently', { path: autoDetectedSentPath }) : t('settings.accounts.autoDetectNoMatchYet')}
                    </option>
                    {flattenedMailboxes.map(m => (
                      <option key={m.path} value={m.path}>{m.label}</option>
                    ))}
                  </select>
                  {selectedAccount.sentFolderOverride && (
                    <p className="text-xs text-mail-text-muted mt-2">
                      {t('settings.accounts.currentSavedOverride')} <code className="text-mail-text">{selectedAccount.sentFolderOverride}</code>
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleSaveSentFolder}
                    disabled={savingSent || sentOverride === (selectedAccount.sentFolderOverride || '')}
                    className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover
                              text-white rounded-lg transition-colors text-sm font-medium
                              disabled:opacity-50"
                  >
                    {savingSent ? t('settings.accounts.saving') : t('settings.accounts.saveSentFolder')}
                  </button>
                  <button
                    onClick={handleAutoCreateSent}
                    disabled={autoCreatingSent}
                    className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                              text-mail-text rounded-lg transition-colors text-sm font-medium
                              flex items-center gap-2 disabled:opacity-50"
                    title={t('settings.accounts.askServerAutoDetectCreate')}
                  >
                    {autoCreatingSent ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {autoCreatingSent ? t('settings.accounts.working') : t('settings.accounts.autoDetectCreate')}
                  </button>
                </div>
              </div>
            </div>

              </>}
              {section === 'advanced' && <>
<div className="settings-section">
                {/* Avatar Color */}
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    {t('settings.accounts.avatarColor')}
                  </label>
                  <p className="text-sm text-mail-text-muted mb-2">
                    {t('settings.accounts.colorUsedAccountAvatarSidebar')}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    {AVATAR_COLORS.map(color => {
                      const currentColor = getAccountColor(accountColors, selectedAccount);
                      const isSelected = currentColor === color;
                      return (
                        <button
                          key={color}
                          onClick={() => setAccountColor(selectedAccountId, color)}
                          className={`w-7 h-7 rounded-full transition-all ${
                            isSelected ? 'ring-2 ring-offset-2 ring-offset-mail-bg' : 'hover:scale-110'
                          }`}
                          style={{
                            backgroundColor: color,
                            '--tw-ring-color': color
                          }}
                          title={color}
                          aria-label={`${t('settings.accounts.avatarColor')}: ${color}`} aria-pressed={isSelected}
                        />
                      );
                    })}
                    {accountColors[selectedAccountId] && (
                      <button
                        onClick={() => clearAccountColor(selectedAccountId)}
                        className="text-xs text-mail-text-muted hover:text-mail-text transition-colors ml-1"
                        title={t('common.resetToDefault')}
                      >
                        {t('common.reset')}
                      </button>
                    )}
                  </div>
                </div>
            </div>
            {/* Hide Account */}
            <div className="settings-section">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {isAccountHidden(selectedAccountId) ? (
                    <EyeOff size={18} className="text-mail-text-muted" />
                  ) : (
                    <Eye size={18} className="text-mail-accent-text" />
                  )}
                  <div>
                    <div className="font-medium text-mail-text">
                      {isAccountHidden(selectedAccountId) ? t('settings.accounts.accountHidden') : t('settings.accounts.accountVisible')}
                    </div>
                    <div className="text-sm text-mail-text-muted">
                      {t('settings.accounts.hiddenAccountsRemovedSidebarStop')}
                    </div>
                  </div>
                </div>
                <ToggleSwitch
                  label={t('settings.accounts.accountVisible')} active={!isAccountHidden(selectedAccountId)}
                  onClick={() => {
                    const currentlyHidden = isAccountHidden(selectedAccountId);
                    setAccountHidden(selectedAccountId, !currentlyHidden);

                    if (!currentlyHidden) {
                      // Hiding: destroy pipeline and switch active account if needed
                      import('../../services/EmailPipelineManager').then(({ pipelineManager }) => {
                        const pipeline = pipelineManager.pipelines.get(selectedAccountId);
                        if (pipeline) {
                          pipeline.destroy();
                          pipelineManager.pipelines.delete(selectedAccountId);
                        }
                      });

                      const { activeAccountId } = useMailStore.getState();
                      if (selectedAccountId === activeAccountId) {
                        // Read fresh hidden state from store (not stale closure)
                        const { hiddenAccounts: currentHidden } = useSettingsStore.getState();
                        const nextVisible = accounts.find(
                          a => a.id !== selectedAccountId && !currentHidden[a.id]
                        );
                        if (nextVisible) {
                          useMailStore.getState().activateAccount(nextVisible.id, 'INBOX');
                        } else {
                          // No visible accounts left — clear active state
                          useMailStore.setState({
                            activeAccountId: null,
                            mailboxes: [],
                            emails: [],
                            localEmails: [],
                            savedEmailIds: new Set(),
                            archivedEmailIds: new Set(),
                            selectedEmailId: null,
                            selectedEmail: null,
                            selectedEmailSource: null
                          });
                        }
                      }
                    } else {
                      // Unhiding: trigger immediate sync
                      import('../../services/EmailPipelineManager').then(({ pipelineManager }) => {
                        const { activeAccountId } = useMailStore.getState();
                        if (!activeAccountId) {
                          useMailStore.getState().activateAccount(selectedAccountId, 'INBOX');
                        }
                        pipelineManager.restartBackgroundPipelines();
                      });
                    }
                  }}
                />
              </div>
            </div>

            {/* Remove Account */}
            <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5 mt-6">
              <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
                <Trash2 size={18} />
                {t('settings.accounts.removeAccount')}
              </h4>

              <p className="text-sm text-mail-text-muted mb-4">
                {t('settings.accounts.removingDeletesEverythingLocal')}
              </p>
              <Button variant="dangerTint"
                onClick={() => setShowRemoveConfirm(selectedAccountId)}
              >
                <Trash2 size={16} />
                {t('settings.accounts.removeAccount2')}
              </Button>

              <AnimatePresence key={selectedAccountId}>
                {showRemoveConfirm === selectedAccountId && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mt-4"
                  >
                    <div className="bg-mail-danger/5 border border-mail-danger/30 rounded-lg p-4">
                      <p className="text-sm text-mail-text mb-1 font-medium">
                        {t('settings.accounts.sureRemoveAccount', { email: selectedAccount.email })}
                      </p>
                      <p className="text-sm text-mail-text-muted mb-2">
                        Deletes this account\u2019s emails, attachments and settings from your vault. Mail still on the server is untouched; anything the server no longer has is gone for good.
                      </p>
                      {accounts.length === 1 && hasPremiumAccess(useSettingsStore.getState().billingProfile) && (
                        <p className="text-sm text-mail-warning mb-2">
                          {t('settings.accounts.lastAccountRemovingWillAlso')}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-3">
                        <button
                          onClick={async () => {
                            const isLast = accounts.length === 1;
                            const result = await removeAccount(selectedAccountId);
                            setShowRemoveConfirm(false);
                            if (!isLast) {
                              const nextAccount = accounts.find(a => a.id !== selectedAccountId);
                              setSelectedAccountId(nextAccount?.id || null);
                            }
                            if (result?.billingLogoutWarning) {
                              setBillingWarning(result.billingLogoutWarning);
                            }
                          }}
                          className="px-4 py-2 bg-mail-danger hover:bg-mail-danger/80
                                    text-white rounded-lg transition-colors text-sm font-medium"
                        >
                          {accounts.length === 1 && hasPremiumAccess(useSettingsStore.getState().billingProfile) ? t('settings.accounts.removeSignOut') : t('settings.accounts.remove')}
                        </button>
                        <button
                          onClick={() => setShowRemoveConfirm(false)}
                          className="px-4 py-2 bg-mail-border hover:bg-mail-border/80
                                    text-mail-text rounded-lg transition-colors text-sm"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
              </>}
            </SettingsTabs>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-mail-text-muted">
            <div className="text-center">
              <User size={48} className="mx-auto mb-4 opacity-30" />
              <p>{t('settings.accounts.selectAccountConfigure')}</p>
            </div>
          </div>
        )}
      </div>

      {verifyOpen && selectedAccount && (
        <SendAsVerifyModal
          isOpen={verifyOpen}
          account={selectedAccount}
          sendAsAddress={sendAs.trim()}
          displayName={accountDisplayName}
          onClose={() => setVerifyOpen(false)}
        />
      )}

      {billingWarning && (
        <Toast
          message={billingWarning}
          type="warning"
          duration={8000}
          onClose={() => setBillingWarning(null)}
        />
      )}
    </div>
  );
}
