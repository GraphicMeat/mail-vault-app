import React, { useState, useEffect, useRef } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore, AVATAR_COLORS, getAccountInitial, getAccountColor, hasPremiumAccess } from '../../stores/settingsStore';
import { getOAuth2AuthUrl, exchangeOAuth2Code, ensureSentMailbox, fetchMailboxes } from '../../services/api';
import { withOAuth2Exchange } from '../../services/authUtils';
import { microsoftImapFields } from '../../services/graphConfig';
import {
  GOOGLE_CLIENT_MAILVAULT,
  GOOGLE_CLIENT_THUNDERBIRD,
  googleClientErrorText,
  googleClientFromStamp,
  loadGoogleClients,
} from '../../services/googleClient';
import { findSentMailboxPath } from '../../utils/sentFolder';
import { isFastmailAccount } from '../AccountModal.jsx';
import { isJmapAccount } from '../../services/providerKind';
import { AliasesSection } from './AliasesSection';
import { AccountTransfer } from './AccountTransfer';
import { AccountGroupField } from './AccountGroupField';
import { DownloadModeControl } from './DownloadModeControl';
import { textToHtml, htmlToText } from '../RichTextEditor';
import { signatureHasContent } from '../../utils/signatureImages';
import { SignatureImageSize } from './SignatureImageSize';
import { SignatureEditor } from './SignatureEditor';
import { Toast } from '../Toast';
import { Loader } from 'lucide-react';
import { t, useT  } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { AccountListView, AccountDetailView, AccountProfileView, AccountConnectionView, AccountAdvancedView, ACCOUNT_SECTIONS } from './views/AccountsView';
import { OutlookImapHelp } from '../OutlookImapHelp';

// The daemon's answer when Outlook.com will not serve the mailbox over IMAP.
const IMAP_REFUSED = 'errors.transportSwitchImapRefused';
import { usePrivateAttr } from '../../hooks/usePrivacy';

export function AccountSettings({ accounts, onUpgrade, onAddAccount, onSetupPhone, onExportAccounts, onImportAccounts, initialAccountId, initialSection = 'profile', onSectionChange }) {
  const t = useT();
  const pa = usePrivateAttr();
  const { removeAccount, activeAccountId, activeMailbox, connectionStatus, connectionError, connectionErrorType, activateAccount } = useAccountStore();
  const {
    signatures,
    setSignature,
    getSignature,
    displayNames,
    setDisplayName,
    getDisplayName,
    getOrderedAccounts,
    setAccountOrder,
    accountColors,
    accountGroups,
    setAccountColor,
    clearAccountColor,
    hiddenAccounts,
    setAccountHidden,
    isAccountHidden,
    openChangeServer,
    transportRefusals,
    setTransportRefusal,
  } = useSettingsStore();

  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || accounts[0]?.id || null);
  const [section, setSection] = useState(ACCOUNT_SECTIONS.includes(initialSection) ? initialSection : 'profile');
  const panelRef = useRef(null);
  const [signatureHtml, setSignatureHtml] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [saved, setSaved] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const autoSaveTimer = useRef(null);
  const autoSavedTimer = useRef(null);
  // Hidden switch: five quick clicks on the visibility eye of a Gmail account
  // re-sign it in through the other Google app (Thunderbird's <-> MailVault's).
  const eyeClicks = useRef({ count: 0, at: 0 });
  const [editingPassword, setEditingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [oauthReconnecting, setOauthReconnecting] = useState(false);
  // What this build offers for Google sign-in, and the app picked in the
  // switch control (null = no change from the account's current one).
  const [googleClients, setGoogleClients] = useState(null);
  const [googleClientPick, setGoogleClientPick] = useState(null);
  // A Microsoft account's transport picked in the switch control (null = no
  // change), the switch in flight, and why the last one failed.
  const [transportPick, setTransportPick] = useState(null);
  const [transportSwitching, setTransportSwitching] = useState(false);
  const [transportError, setTransportError] = useState(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(null);
  const [revokeGoogle, setRevokeGoogle] = useState(false);
  const [removingAccount, setRemovingAccount] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [billingWarning, setBillingWarning] = useState(null);
  const [accountMailboxes, setAccountMailboxes] = useState([]);
  const [sentOverride, setSentOverride] = useState('');
  const [savingSent, setSavingSent] = useState(false);
  const [autoCreatingSent, setAutoCreatingSent] = useState(false);

  const orderedAccounts = getOrderedAccounts(accounts);
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  // A JMAP account shows its session, sign-in kind and login, never IMAP/SMTP
  // hosts: those fields would turn it into an IMAP account.
  const selectedIsJmap = isJmapAccount(selectedAccount);
  const jmapToken = selectedIsJmap && selectedAccount?.jmapAuth === 'bearer';
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
  const invoke = window.__TAURI__?.core?.invoke;

  const changeSection = value => {
    setSection(value);
    onSectionChange?.(value);
  };

  useEffect(() => {
    if (ACCOUNT_SECTIONS.includes(initialSection)) setSection(initialSection);
  }, [initialSection]);

  // A Google account's sign-in app: read what the build offers once, and drop
  // an unapplied pick when another account is selected.
  const isGoogleOAuth = selectedAccount?.authType === 'oauth2' && selectedAccount?.oauth2Provider === 'google';
  useEffect(() => {
    if (!isGoogleOAuth || googleClients) return undefined;
    let live = true;
    loadGoogleClients().then(clients => { if (live) setGoogleClients(clients); });
    return () => { live = false; };
  }, [isGoogleOAuth, googleClients]);
  useEffect(() => { setGoogleClientPick(null); setTransportPick(null); setTransportError(null); }, [selectedAccountId]);
  const isMicrosoftOAuth = selectedAccount?.authType === 'oauth2' && (selectedAccount?.oauth2Provider || 'microsoft') === 'microsoft';

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
      setShowRemoveConfirm(false);
      setEditingPassword(false);
      setNewPassword('');
    }
  }, [selectedAccountId]);

  // Autosave display name + signature — no Save button
  const pendingEdits = useRef({ html: '', name: '' });
  pendingEdits.current = { html: signatureHtml, name: accountDisplayName };

  const persistAccountSettings = (accountId, rawHtml, name) => {
    if (!accountId) return;
    const sig = getSignature(accountId);
    const text = htmlToText(rawHtml);
    const hasContent = signatureHasContent(rawHtml, text);
    const html = hasContent ? rawHtml : '';
    const nameChanged = (getDisplayName(accountId) || '') !== name;
    const sigChanged = (sig.html || '') !== html || (sig.text || '') !== text;
    if (!nameChanged && !sigChanged) return;

    if (nameChanged) setDisplayName(accountId, name);
    if (sigChanged) {
      setSignature(accountId, {
        ...sig,
        html,
        text,
        // first content on a never-configured signature turns it on
        enabled: sig.enabled || (!sig.html && !sig.text && hasContent),
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
      () => persistAccountSettings(accountId, signatureHtml, accountDisplayName),
      400
    );
    return () => clearTimeout(autoSaveTimer.current);
  }, [signatureHtml, accountDisplayName, selectedAccountId]);

  // Flush pending edits when switching accounts or leaving Settings
  useEffect(() => {
    const accountId = selectedAccountId;
    return () => {
      clearTimeout(autoSaveTimer.current);
      persistAccountSettings(
        accountId,
        pendingEdits.current.html,
        pendingEdits.current.name
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
      const { patchAccount } = await import('../../services/db');
      await patchAccount(selectedAccountId, { sentFolderOverride: nextOverride });
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
      const { patchAccount, saveMailboxes } = await import('../../services/db');
      await patchAccount(selectedAccountId, { sentFolderOverride: path });
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

  // Reconnect OAuth2 account — preserves Graph transport, custom client/tenant.
  // `googleClientChoice` ("thunderbird" | "mailvault") is the Google app to sign
  // in through. Without one, the account keeps the app it has now: a Reconnect
  // must never move an account between apps (a refresh token only works with
  // the app that issued it, and the move changes what Google shows).
  const handleEyeClick = () => {
    if (!isGoogleOAuth || oauthReconnecting) return;
    const now = Date.now();
    const clicks = eyeClicks.current;
    clicks.count = now - clicks.at > 1500 ? 1 : clicks.count + 1;
    clicks.at = now;
    if (clicks.count < 5) return;
    clicks.count = 0;
    const current = googleClientFromStamp(selectedAccount?.oauth2ClientId, googleClients);
    handleOAuth2Reconnect(current === GOOGLE_CLIENT_MAILVAULT ? GOOGLE_CLIENT_THUNDERBIRD : GOOGLE_CLIENT_MAILVAULT);
  };

  const handleOAuth2Reconnect = async (googleClientChoice) => {
    if (!selectedAccountId) return;
    setOauthReconnecting(true);

    try {
      const account = accounts.find(a => a.id === selectedAccountId);
      const provider = account?.oauth2Provider || 'microsoft';
      const useGraph = account?.oauth2Transport === 'graph';
      let googleClient;
      if (provider === 'google') {
        googleClient = googleClientChoice === GOOGLE_CLIENT_MAILVAULT || googleClientChoice === GOOGLE_CLIENT_THUNDERBIRD
          ? googleClientChoice
          : googleClientFromStamp(account?.oauth2ClientId, googleClients ?? await loadGoogleClients());
      }
      const { authUrl, state } = await getOAuth2AuthUrl(
        account?.email,
        provider,
        account?.oauth2CustomClientId,
        account?.oauth2TenantId,
        useGraph,
        googleClient
      );

      if (invoke) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      const tokenData = await exchangeOAuth2Code(state);

      const { patchAccount, accountExpectedContext } = await import('../../services/db');
      if (account) {
        // Spread all existing account fields to preserve oauth2Transport,
        // oauth2Provider, oauth2CustomClientId, oauth2TenantId, etc. The new
        // tokens come from the client this sign-in used, so oauth2ClientId is
        // replaced with it in the same write: an account that still carried
        // Thunderbird's (or no) stamp would otherwise refresh the new tokens
        // with the wrong client.
        const grant = withOAuth2Exchange({}, tokenData);
        const unset = grant.oauth2ClientId === undefined ? ['oauth2ClientId'] : [];
        await patchAccount(account.id, grant, { unset, expected: accountExpectedContext(account, 'oauth') });
      }

      const { init } = useMailStore.getState();
      await init();

      setGoogleClientPick(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('OAuth2 reconnect failed:', error);
      const failure = googleClientErrorText(error, t);
      alert(t('settings.accounts.couldReconnectAccountCheckPassword') + (failure || error));
    } finally {
      setOauthReconnecting(false);
    }
  };

  // Graph <-> IMAP in place: sign in again with the new transport's scopes,
  // then the daemon re-files the vault and saves the account. Nothing changes
  // when the sign-in is cancelled or fails.
  const handleTransportSwitch = async (next) => {
    const account = accounts.find(a => a.id === selectedAccountId);
    if (!account || transportSwitching) return;
    setTransportSwitching(true);
    setTransportError(null);
    try {
      const { authUrl, state } = await getOAuth2AuthUrl(
        account.email, 'microsoft', account.oauth2CustomClientId, account.oauth2TenantId, next === 'graph',
      );
      if (invoke) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }
      const grant = withOAuth2Exchange({}, await exchangeOAuth2Code(state));
      const { switchAccountTransport, accountExpectedContext } = await import('../../services/db');
      const fields = { ...grant, ...(next === 'imap' ? microsoftImapFields(account) : {}) };
      await switchAccountTransport(account.id, next, fields, {
        unset: grant.oauth2ClientId === undefined ? ['oauth2ClientId'] : [],
        expected: accountExpectedContext(account, 'oauth'),
      });
      setTransportPick(null);
      setTransportRefusal(account.id, null);
      await useMailStore.getState().init();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Transport switch failed:', error);
      const key = error?.message;
      setTransportError(typeof key === 'string' && key.startsWith('errors.') ? t(key) : String(key || error));
      // Outlook refusing IMAP outlives this screen: the help stays for the
      // account until IMAP is on and a switch goes through.
      if (key === IMAP_REFUSED) setTransportRefusal(account.id, key);
    } finally {
      setTransportSwitching(false);
    }
  };

  // Update account password
  const handleUpdatePassword = async () => {
    if (!selectedAccountId || !newPassword.trim()) return;

    try {
      const account = accounts.find(a => a.id === selectedAccountId);
      if (!account) throw new Error(t('errors.accountNotFound'));
      const { patchAccount, accountExpectedContext } = await import('../../services/db');
      await patchAccount(account.id, { password: newPassword }, { expected: accountExpectedContext(account) });

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

  // Microsoft Graph or IMAP, switched in place
  const transportSwitch = isMicrosoftOAuth && (() => {
    const current = selectedAccount.oauth2Transport === 'graph' ? 'graph' : 'imap';
    const refusal = transportRefusals?.[selectedAccount.id];
    const pick = transportPick ?? current;
    const name = key => t(key === 'graph' ? 'account.msTransportGraph' : 'account.msTransportImap');
    return (
      <div className="pt-4 border-t border-mail-border space-y-2" data-testid="ms-transport-section">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-mail-text">{t('account.msTransport')}</div>
            <div className="text-sm text-mail-text-muted" data-testid="ms-transport-current">{name(current)}</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label={t('account.msTransport')}
              value={pick}
              onChange={e => setTransportPick(e.target.value)}
              disabled={transportSwitching || oauthReconnecting}
              className="px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text disabled:opacity-50"
            >
              <option value="graph">{t('account.msTransportGraph')}</option>
              <option value="imap">{t('account.msTransportImap')}</option>
            </select>
            <button
              onClick={() => handleTransportSwitch(pick)}
              disabled={transportSwitching || oauthReconnecting || pick === current}
              className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                        text-mail-text rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {transportSwitching && <Loader size={16} className="animate-spin" />}
              {transportSwitching ? t('settings.accounts.transportSwitching') : t('settings.accounts.transportSwitch')}
            </button>
          </div>
        </div>
        {(transportError || refusal) && <p role="alert" className="text-xs text-mail-danger">{transportError || t(refusal)}</p>}
        {refusal === IMAP_REFUSED && <OutlookImapHelp />}
        <p className="text-xs text-mail-text-muted">{t('settings.accounts.transportExplain')}</p>
      </div>
    );
  })();

  // Which Google app this account signs in through
  const googleClientSwitch = isGoogleOAuth && (() => {
    const current = googleClientFromStamp(selectedAccount.oauth2ClientId, googleClients);
    const pick = googleClientPick ?? current;
    const ownAvailable = !!googleClients?.mailvault;
    const appName = key => t(key === GOOGLE_CLIENT_MAILVAULT ? 'googleClient.nameMailvault' : 'googleClient.nameThunderbird');
    return (
      <div className="pt-4 border-t border-mail-border space-y-2" data-testid="google-client-section">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-mail-text">{t('googleClient.settingsLabel')}</div>
            <div className="text-sm text-mail-text-muted" data-testid="google-client-current">{appName(current)}</div>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label={t('googleClient.settingsLabel')}
              value={pick}
              onChange={e => setGoogleClientPick(e.target.value)}
              disabled={oauthReconnecting}
              className="px-3 py-2 text-sm bg-mail-bg border border-mail-border rounded-lg text-mail-text disabled:opacity-50"
            >
              <option value={GOOGLE_CLIENT_THUNDERBIRD}>{t('googleClient.thunderbird')}</option>
              <option value={GOOGLE_CLIENT_MAILVAULT} disabled={!ownAvailable}>{t('googleClient.mailvault')}</option>
            </select>
            <button
              onClick={() => handleOAuth2Reconnect(pick)}
              disabled={oauthReconnecting || pick === current}
              className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                        text-mail-text rounded-lg transition-colors disabled:opacity-50"
            >
              {t('googleClient.switch')}
            </button>
          </div>
        </div>
        {googleClients && !ownAvailable && (
          <p className="text-xs text-mail-text-muted">{t('googleClient.ownUnavailable')}</p>
        )}
        <p className="text-xs text-mail-text-muted">{t('googleClient.explain')}</p>
      </div>
    );
  })();

  const handleHidden = hidden => {
    const currentlyHidden = isAccountHidden(selectedAccountId);
    if (currentlyHidden === hidden) return;
    setAccountHidden(selectedAccountId, hidden);

    if (!currentlyHidden) {
      // Hiding: the daemon retires the account's download-ahead when the
      // coordinator next reports the view; switch active account if needed
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
      // Unhiding: the coordinator reports the view again and the daemon
      // queues the account's download-ahead.
      const { activeAccountId } = useMailStore.getState();
      if (!activeAccountId) {
        useMailStore.getState().activateAccount(selectedAccountId, 'INBOX');
      }
    }
  };

  const lastPremiumAccount = accounts.length === 1 && hasPremiumAccess(useSettingsStore.getState().billingProfile);
  // Only a grant of MailVault's own Google client can be revoked: Thunderbird's is shared.
  const canRevokeGoogle = isGoogleOAuth && googleClientFromStamp(selectedAccount?.oauth2ClientId, googleClients) === GOOGLE_CLIENT_MAILVAULT;
  const handleRemove = async () => {
    if (removingAccount) return;
    setRemovingAccount(true);
    setRemoveError(null);
    try {
      const isLast = accounts.length === 1;
      const result = await removeAccount(selectedAccountId, { revokeGoogle: revokeGoogle && canRevokeGoogle });
      setShowRemoveConfirm(false);
      if (!isLast) {
        const nextAccount = accounts.find(a => a.id !== selectedAccountId);
        setSelectedAccountId(nextAccount?.id || null);
      }
      if (result?.billingLogoutWarning) {
        setBillingWarning(result.billingLogoutWarning);
      }
    } catch (error) {
      setRemoveError(error?.outcome === 'busy' ? 'settings.accounts.removeBusy'
        : error?.outcome === 'incomplete' ? 'settings.accounts.removeIncomplete'
          : 'settings.accounts.removeFailed');
    } finally {
      setRemovingAccount(false);
    }
  };

  const sectionContent = !selectedAccount ? null : section === 'profile' ? (
    <AccountProfileView
      emailLabel={isFastmailAccount(selectedAccount) ? t('account.loginAddress') : t('account.emailAddress')}
      email={selectedAccount.email} displayName={accountDisplayName} onDisplayName={setAccountDisplayName}
      groupField={<AccountGroupField accountId={selectedAccountId} />}
      signatureEnabled={!!getSignature(selectedAccountId).enabled}
      onSignatureEnabled={enabled => {
        const sig = getSignature(selectedAccountId);
        setSignature(selectedAccountId, { ...sig, enabled });
      }}
      signatureEditor={<>
        <SignatureEditor
          html={signatureHtml}
          onChange={setSignatureHtml}
          placeholder={t('settings.accounts.bestRegardsJohnDoe')}
        />
        <p className="text-xs text-mail-text-muted mt-2">
          {t('settings.accounts.boldItalicLinksListsSupported')}
        </p>
        <p className="text-xs text-mail-text-muted mt-1">
          {t('settings.accounts.signatureImageHint')}
        </p>
        <SignatureImageSize html={signatureHtml} />
      </>} />
  ) : section === 'aliases' ? (
    <AliasesSection account={selectedAccount} displayName={accountDisplayName} />
  ) : section === 'connection' ? (
    <AccountConnectionView key={selectedAccountId}
      errorDetails={hasConnectionError ? connectionError : null}
      auth={{
        oauth: selectedAccount.authType === 'oauth2',
        provider: selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft',
        token: jmapToken, jmap: selectedIsJmap, stored: !!selectedAccount.password,
      }}
      onReconnect={() => handleOAuth2Reconnect()} reconnecting={oauthReconnecting}
      oauthExtra={<>
        {/* Microsoft Graph or IMAP, switched in place */}
        {isMicrosoftOAuth && transportSwitch}
        {/* Which Google app this account signs in through */}
        {isGoogleOAuth && googleClientSwitch}
      </>}
      editingPassword={editingPassword}
      onEditPassword={editing => {
        setEditingPassword(editing);
        if (!editing) setNewPassword('');
      }}
      newPassword={newPassword} onNewPassword={setNewPassword} onSavePassword={handleUpdatePassword}
      replaceLabel={selectedIsJmap ? t('account.jmapReplaceSecret') : t('settings.accounts.newPassword')}
      server={selectedAccount.authType === 'oauth2' ? null : selectedIsJmap
        ? { jmap: { sessionUrl: selectedAccount.jmapSessionUrl, token: jmapToken, username: selectedAccount.jmapUsername || selectedAccount.email } }
        : {
          imap: { host: selectedAccount.imapHost, port: selectedAccount.imapPort, security: selectedAccount.imapSecurity },
          smtp: { host: selectedAccount.smtpHost, port: selectedAccount.smtpPort },
        }}
      onChangeServer={() => openChangeServer(selectedAccountId)}
      sent={{
        value: sentOverride, onChange: setSentOverride, options: flattenedMailboxes,
        autoLabel: autoDetectedSentPath ? t('settings.accounts.autoDetectCurrently', { path: autoDetectedSentPath }) : t('settings.accounts.autoDetectNoMatchYet'),
        savedOverride: selectedAccount.sentFolderOverride, onSave: handleSaveSentFolder, saving: savingSent,
        onAutoCreate: handleAutoCreateSent, autoCreating: autoCreatingSent,
      }} />
  ) : (
    <AccountAdvancedView key={selectedAccountId}
      colors={AVATAR_COLORS} color={getAccountColor(accountColors, selectedAccount)}
      onColor={color => setAccountColor(selectedAccountId, color)}
      onResetColor={accountColors[selectedAccountId] ? () => clearAccountColor(selectedAccountId) : undefined}
      downloadMode={<DownloadModeControl accountId={selectedAccountId} onUpgrade={onUpgrade} />}
      hidden={isAccountHidden(selectedAccountId)} onHidden={handleHidden} onEyeClick={handleEyeClick}
      remove={{
        confirming: showRemoveConfirm === selectedAccountId,
        onAsk: () => { setRemoveError(null); setRevokeGoogle(false); setShowRemoveConfirm(selectedAccountId); },
        onCancel: () => setShowRemoveConfirm(false),
        onConfirm: handleRemove,
        removing: removingAccount,
        error: removeError && t(removeError),
        question: t('settings.accounts.sureRemoveAccount', { email: pa(selectedAccount.email, 'email') }),
        warning: lastPremiumAccount ? t('settings.accounts.lastAccountRemovingWillAlso') : null,
        confirmLabel: lastPremiumAccount ? t('settings.accounts.removeSignOut') : t('common.remove'),
        revoke: canRevokeGoogle ? { checked: revokeGoogle, onChange: setRevokeGoogle } : null,
      }} />
  );

  return (
    <DesktopViewEnv>
    <div className="account-settings-layout">
      {/* Account List - Left Column */}
      <AccountListView
        accounts={orderedAccounts.map(account => ({
          id: account.id, email: account.email, initial: getAccountInitial(account, getDisplayName(account.id)),
          name: getDisplayName(account.id) || account.name || account.email?.split('@')[0] || 'Unknown',
          color: getAccountColor(accountColors, account), hidden: !!hiddenAccounts[account.id],
          oauth: account.authType === 'oauth2', group: accountGroups[account.id] || null,
        }))}
        selectedId={selectedAccountId} onSelect={setSelectedAccountId} onReorder={setAccountOrder} onAdd={onAddAccount}
        footer={<AccountTransfer accounts={accounts} onSetupPhone={onSetupPhone} onExportAccounts={onExportAccounts} onImportAccounts={onImportAccounts} />} />

      {/* Account Settings - Right Column */}
      <AccountDetailView panelRef={panelRef}
        identity={selectedAccount ? {
          name: getDisplayName(selectedAccountId) || selectedAccount.name || selectedAccount.email,
          email: selectedAccount.email, color: getAccountColor(accountColors, selectedAccount),
          initial: getAccountInitial(selectedAccount, getDisplayName(selectedAccountId)),
        } : null}
        saved={autoSaved || saved}
        status={{
          label: statusLabel,
          tone: hasConnectionError && !isHidden ? 'error' : isActiveAccount && connectionStatus === 'connected' && !isHidden ? 'connected' : isHidden ? 'hidden' : 'idle',
          action: hasConnectionError && !isHidden ? {
            disabled: oauthReconnecting,
            onClick: () => {
              if (needsPassword) { changeSection('connection'); setEditingPassword(true); }
              else if (needsSignIn) handleOAuth2Reconnect();
              else activateAccount(selectedAccountId, activeMailbox || 'INBOX');
            },
            label: oauthReconnecting ? t('settings.accounts.reconnecting') : needsPassword ? t('settings.accounts.enterPassword')
              : needsSignIn ? t('settings.accounts.reconnect') : t('common.retry'),
          } : null,
        }}
        section={section} onSection={changeSection}>
        {selectedAccount && sectionContent}
      </AccountDetailView>

      {billingWarning && (
        <Toast
          message={billingWarning}
          type="warning"
          duration={8000}
          onClose={() => setBillingWarning(null)}
        />
      )}
    </div>
    </DesktopViewEnv>
  );
}
