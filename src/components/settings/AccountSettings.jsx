import React, { useState, useEffect } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore, AVATAR_COLORS, getAccountInitial, getAccountColor } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import { getOAuth2AuthUrl, exchangeOAuth2Code } from '../../services/api';
import { ToggleSwitch } from './ToggleSwitch';
import {
  User,
  Mail,
  FileText,
  Shield,
  Check,
  Trash2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Loader,
  RefreshCw,
  Key,
  Link,
  Unlink,
  Plus,
  Eye,
  EyeOff,
  Save,
} from 'lucide-react';

export function AccountSettings({ accounts, onAddAccount, initialAccountId }) {
  const { removeAccount } = useMailStore();
  const {
    signatures,
    setSignature,
    getSignature,
    displayNames,
    setDisplayName,
    getDisplayName,
    accountOrder,
    getOrderedAccounts,
    setAccountOrder,
    accountColors,
    setAccountColor,
    clearAccountColor,
    hiddenAccounts,
    setAccountHidden,
    isAccountHidden,
  } = useSettingsStore();

  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || accounts[0]?.id || null);
  const [signatureText, setSignatureText] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [saved, setSaved] = useState(false);
  const [editingPassword, setEditingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [oauthReconnecting, setOauthReconnecting] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const orderedAccounts = getOrderedAccounts(accounts);
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const invoke = window.__TAURI__?.core?.invoke;

  const moveAccount = (accountId, direction) => {
    const ids = orderedAccounts.map(a => a.id);
    const idx = ids.indexOf(accountId);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= ids.length) return;
    ids.splice(idx, 1);
    ids.splice(newIdx, 0, accountId);
    setAccountOrder(ids);
  };

  // Load signature and display name when account changes
  useEffect(() => {
    if (selectedAccountId) {
      const sig = getSignature(selectedAccountId);
      setSignatureText(sig.text || '');
      setAccountDisplayName(getDisplayName(selectedAccountId) || '');
      setShowRemoveConfirm(false);
    }
  }, [selectedAccountId]);

  const handleSaveAccountSettings = () => {
    if (selectedAccountId) {
      setDisplayName(selectedAccountId, accountDisplayName);
      setSignature(selectedAccountId, {
        text: signatureText,
        html: signatureText.replace(/\n/g, '<br>'),
        enabled: !!signatureText.trim()
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  // Reconnect OAuth2 account
  const handleOAuth2Reconnect = async () => {
    if (!selectedAccountId) return;
    setOauthReconnecting(true);

    try {
      const account = accounts.find(a => a.id === selectedAccountId);
      const provider = account?.oauth2Provider || 'microsoft';
      const { authUrl, state } = await getOAuth2AuthUrl(account?.email, provider);

      if (invoke) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      const tokenData = await exchangeOAuth2Code(state);

      const { saveAccount } = await import('../../services/db');
      if (account) {
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
      alert('Reconnect failed: ' + (error.message || error));
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
      alert('Failed to update password: ' + error);
    }
  };

  return (
    <div className="flex h-full">
      {/* Account List - Left Column */}
      <div className="w-72 border-r border-mail-border bg-mail-surface/50 overflow-y-auto">
        <div className="p-4">
          <div className="text-xs text-mail-text-muted uppercase tracking-wide mb-3">
            Your Accounts
          </div>
          {accounts.length === 0 ? (
            <div className="text-center py-8 text-mail-text-muted">
              <Mail size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No accounts configured</p>
            </div>
          ) : (
            <div className="space-y-1">
              {orderedAccounts.map((account, index) => (
                <div
                  key={account.id}
                  onClick={() => setSelectedAccountId(account.id)}
                  className={`group/acct flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all
                             ${account.id === selectedAccountId
                               ? 'bg-mail-accent/10 border border-mail-accent/30'
                               : 'hover:bg-mail-surface-hover border border-transparent'}`}
                >
                  {orderedAccounts.length > 1 && (
                    <div className="flex flex-col opacity-0 group-hover/acct:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); moveAccount(account.id, -1); }}
                        disabled={index === 0}
                        className={`p-0.5 rounded transition-colors ${index === 0 ? 'opacity-0' : 'hover:bg-mail-border'}`}
                        title="Move up"
                      >
                        <ChevronUp size={12} className="text-mail-text-muted" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); moveAccount(account.id, 1); }}
                        disabled={index === orderedAccounts.length - 1}
                        className={`p-0.5 rounded transition-colors ${index === orderedAccounts.length - 1 ? 'opacity-0' : 'hover:bg-mail-border'}`}
                        title="Move down"
                      >
                        <ChevronDown size={12} className="text-mail-text-muted" />
                      </button>
                    </div>
                  )}
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold select-none${hiddenAccounts[account.id] ? ' opacity-40' : ''}`}
                    style={{ backgroundColor: getAccountColor(accountColors, account) }}
                  >
                    {getAccountInitial(account, getDisplayName(account.id))}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-mail-text truncate flex items-center gap-1.5">
                      {getDisplayName(account.id) || account.name || account.email?.split('@')[0] || 'Unknown'}
                      {account.authType === 'oauth2' && (
                        <Shield size={12} className="text-blue-500 flex-shrink-0" />
                      )}
                      {hiddenAccounts[account.id] && (
                        <EyeOff size={12} className="text-mail-text-muted flex-shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-mail-text-muted truncate">
                      {account.email}
                    </div>
                  </div>
                  {account.id === selectedAccountId && (
                    <ChevronRight size={16} className="text-mail-accent" />
                  )}
                </div>
              ))}
            </div>
          )}
          {onAddAccount && (
            <button
              onClick={onAddAccount}
              className="w-full mt-3 flex items-center justify-center gap-2 p-2.5 text-sm text-mail-text-muted
                        hover:text-mail-text hover:bg-mail-surface-hover border border-dashed border-mail-border
                        rounded-lg transition-all"
            >
              <Plus size={16} />
              Add Account
            </button>
          )}
        </div>
      </div>

      {/* Account Settings - Right Column */}
      <div className="flex-1 overflow-y-auto p-6">
        {selectedAccount ? (
          <div className="space-y-6">
            {/* Account Info */}
            <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <User size={18} className="text-mail-accent" />
                Account Settings
              </h4>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    Email Address
                  </label>
                  <input
                    type="text"
                    value={selectedAccount.email}
                    disabled
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text-muted cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    Display Name
                  </label>
                  <p className="text-sm text-mail-text-muted mb-2">
                    Name shown in the "From" field when sending emails
                  </p>
                  <input
                    type="text"
                    value={accountDisplayName}
                    onChange={(e) => setAccountDisplayName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text placeholder-mail-text-muted
                              focus:border-mail-accent transition-all"
                  />
                </div>

                {/* Avatar Color */}
                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    Avatar Color
                  </label>
                  <p className="text-sm text-mail-text-muted mb-2">
                    Color used for the account avatar in the sidebar
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
                        />
                      );
                    })}
                    {accountColors[selectedAccountId] && (
                      <button
                        onClick={() => clearAccountColor(selectedAccountId)}
                        className="text-xs text-mail-text-muted hover:text-mail-text transition-colors ml-1"
                        title="Reset to default"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Hide Account */}
            <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {isAccountHidden(selectedAccountId) ? (
                    <EyeOff size={18} className="text-mail-text-muted" />
                  ) : (
                    <Eye size={18} className="text-mail-accent" />
                  )}
                  <div>
                    <div className="font-medium text-mail-text">
                      {isAccountHidden(selectedAccountId) ? 'Account Hidden' : 'Account Visible'}
                    </div>
                    <div className="text-sm text-mail-text-muted">
                      Hidden accounts are removed from the sidebar and stop syncing
                    </div>
                  </div>
                </div>
                <ToggleSwitch
                  active={!isAccountHidden(selectedAccountId)}
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

            {/* Signature */}
            <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <FileText size={18} className="text-mail-accent" />
                Email Signature
              </h4>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-mail-text">Enable Signature</div>
                    <div className="text-sm text-mail-text-muted">
                      Automatically add to outgoing emails
                    </div>
                  </div>
                  <ToggleSwitch
                    active={getSignature(selectedAccountId).enabled}
                    onClick={() => {
                      const sig = getSignature(selectedAccountId);
                      setSignature(selectedAccountId, { ...sig, enabled: !sig.enabled });
                    }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-mail-text mb-2">
                    Signature Content
                  </label>
                  <textarea
                    value={signatureText}
                    onChange={(e) => setSignatureText(e.target.value)}
                    placeholder="Best regards,&#10;John Doe&#10;john@example.com"
                    rows={5}
                    className="w-full px-4 py-3 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text placeholder-mail-text-muted resize-none
                              font-mono text-sm focus:border-mail-accent transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Password / Authentication */}
            <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
              <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
                <Key size={18} className="text-mail-accent" />
                Authentication
              </h4>

              {/* Auth type badge */}
              <div className="flex items-center gap-2 mb-4">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                  ${selectedAccount.authType === 'oauth2'
                    ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20'
                    : 'bg-mail-accent/10 text-mail-accent border border-mail-accent/20'}`}>
                  {selectedAccount.authType === 'oauth2' ? (
                    <><Shield size={12} /> {selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft'} OAuth2</>
                  ) : (
                    <><Key size={12} /> Password</>
                  )}
                </span>
                {selectedAccount.authType === 'oauth2' && (
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                    ${selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now()
                      ? 'bg-mail-success/10 text-mail-success border border-mail-success/20'
                      : 'bg-mail-warning/10 text-mail-warning border border-mail-warning/20'}`}>
                    {selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now() ? (
                      <><Link size={12} /> Connected</>
                    ) : (
                      <><Unlink size={12} /> Token expired</>
                    )}
                  </span>
                )}
              </div>

              {/* OAuth2 account */}
              {selectedAccount.authType === 'oauth2' ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-mail-text">{selectedAccount.oauth2Provider === 'google' ? 'Google' : 'Microsoft'} Account</div>
                      <div className="text-sm text-mail-text-muted">
                        {selectedAccount.oauth2ExpiresAt && selectedAccount.oauth2ExpiresAt > Date.now()
                          ? 'Authenticated via OAuth2. Tokens refresh automatically before expiry.'
                          : 'Token expired. Tokens will refresh automatically on the next email operation, or click Reconnect.'}
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
                      {oauthReconnecting ? 'Reconnecting...' : 'Reconnect'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Password auth */}
                  {!selectedAccount.password && (
                    <div className="flex items-center gap-3 p-3 bg-mail-warning/10 border border-mail-warning/20 rounded-lg mb-4">
                      <div className="w-3 h-3 bg-mail-warning rounded-full" />
                      <span className="text-sm text-mail-text">
                        Password not found. Please re-enter your password to reconnect.
                      </span>
                    </div>
                  )}

                  {editingPassword ? (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-mail-text mb-2">
                          New Password
                        </label>
                        <input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Enter your email password"
                          className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                    text-mail-text placeholder-mail-text-muted
                                    focus:border-mail-accent transition-all"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleUpdatePassword}
                          disabled={!newPassword.trim()}
                          className="px-4 py-2 bg-mail-accent hover:bg-mail-accent-hover
                                    text-white rounded-lg transition-colors disabled:opacity-50"
                        >
                          Save Password
                        </button>
                        <button
                          onClick={() => {
                            setEditingPassword(false);
                            setNewPassword('');
                          }}
                          className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                    text-mail-text rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium text-mail-text">Password</div>
                        <div className="text-sm text-mail-text-muted">
                          {selectedAccount.password ? 'Stored securely in system keychain' : 'Not configured'}
                        </div>
                      </div>
                      <button
                        onClick={() => setEditingPassword(true)}
                        className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                                  text-mail-text rounded-lg transition-colors flex items-center gap-2"
                      >
                        <Key size={16} />
                        {selectedAccount.password ? 'Update' : 'Set Password'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
              <button
                onClick={handleSaveAccountSettings}
                className="flex items-center gap-2 px-5 py-2.5 bg-mail-accent
                          hover:bg-mail-accent-hover text-white rounded-lg
                          font-medium transition-all"
              >
                {saved ? <Check size={18} /> : <Save size={18} />}
                {saved ? 'Saved!' : 'Save Changes'}
              </button>
            </div>

            {/* Remove Account */}
            <div className="bg-mail-surface border border-mail-danger/30 rounded-xl p-5 mt-6">
              <h4 className="font-semibold text-mail-danger mb-4 flex items-center gap-2">
                <Trash2 size={18} />
                Remove Account
              </h4>

              <p className="text-sm text-mail-text-muted mb-4">
                This will remove the account from MailVault. All locally archived emails,
                attachments, and settings for this account will be permanently deleted
                and cannot be recovered.
              </p>
              <button
                onClick={() => setShowRemoveConfirm(true)}
                className="px-4 py-2 bg-mail-danger/10 hover:bg-mail-danger/20
                          text-mail-danger rounded-lg transition-colors flex items-center gap-2"
              >
                <Trash2 size={16} />
                Remove This Account
              </button>

              <AnimatePresence>
                {showRemoveConfirm && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mt-4"
                  >
                    <div className="bg-mail-danger/5 border border-mail-danger/30 rounded-lg p-4">
                      <p className="text-sm text-mail-text mb-1 font-medium">
                        Are you sure you want to remove {selectedAccount.email}?
                      </p>
                      <p className="text-sm text-mail-text-muted mb-4">
                        This will permanently delete all locally archived emails, attachments, and settings for this account. This action cannot be undone.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            removeAccount(selectedAccountId);
                            setShowRemoveConfirm(false);
                            if (accounts.length > 1) {
                              const nextAccount = accounts.find(a => a.id !== selectedAccountId);
                              setSelectedAccountId(nextAccount?.id || null);
                            }
                          }}
                          className="px-4 py-2 bg-mail-danger hover:bg-mail-danger/80
                                    text-white rounded-lg transition-colors text-sm font-medium"
                        >
                          Remove
                        </button>
                        <button
                          onClick={() => setShowRemoveConfirm(false)}
                          className="px-4 py-2 bg-mail-border hover:bg-mail-border/80
                                    text-mail-text rounded-lg transition-colors text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-mail-text-muted">
            <div className="text-center">
              <User size={48} className="mx-auto mb-4 opacity-30" />
              <p>Select an account to configure</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
