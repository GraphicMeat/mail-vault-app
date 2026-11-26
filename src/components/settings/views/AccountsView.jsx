// Settings > Accounts as views: the account list, one account's page (its name and status over the
// four sections as tabs) and each section: Profile, Connection and Advanced here, Aliases in
// AliasesView.jsx. Both apps feed them: desktop from its stores (AccountSettings.jsx), the phone
// from its engine (src/mobile/settings/Accounts.jsx). Whatever only one app can do arrives as a
// node (desktop's rich signature editor, account group, Microsoft transport and Google sign-in
// switches, download mode; the phone's server form) or is left out when its callback is absent.
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User, Mail, FileText, Shield, Check, Trash2, Loader, RefreshCw, Key, AlertCircle, Plus, Eye, EyeOff, Server, HardDrive, Send,
  ChevronUp, ChevronDown,
} from 'lucide-react';
import { groupAccounts, moveGroup, reorderWithinGroup } from '../../../utils/groupAccounts';
import { Button } from '../../ui/Button';
import { SettingsTabs } from '../../ui/SettingsTabs';
import { ReorderListView } from './ReorderListView';
import { useT, useViewEnv } from './viewContext';
import '../../../styles/account-settings-navigation.css';

/** The sub-sections of an account's settings, in tab order. */
export const ACCOUNT_SECTIONS = ['profile', 'aliases', 'connection', 'advanced'];

const FIELD = 'w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg';

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

/**
 * The left column: every account (`{ id, email, name, initial, color, hidden, oauth, group }`),
 * the selected one pressed, in the sidebar's groups (ungrouped first, each group under its name).
 * `onReorder(ids)` makes the list orderable (desktop): accounts move within their group and a
 * group moves up or down past its neighbour. `onAdd` shows "Add account"; `footer` sits under it
 * (desktop's phone setup and move to another computer); `style` and `listRef` reach the column.
 */
export function AccountListView({ accounts, selectedId, onSelect, onReorder, onAdd, footer = null, style, listRef }) {
  const t = useT();
  const { Private, privateAttr: pa } = useViewEnv();
  const groupOf = Object.fromEntries(accounts.filter(account => account.group).map(account => [account.id, account.group]));
  const sections = groupAccounts(accounts, groupOf);
  const grouped = sections.some(section => section.name !== null);
  const reorderable = section => onReorder && (ids => onReorder(reorderWithinGroup(accounts, groupOf, section.name, ids)));
  const shiftGroup = (name, delta) => {
    const ids = moveGroup(accounts, groupOf, name, delta);
    if (ids) onReorder(ids);
  };
  const row = account => (
    <button type="button" className="account-settings-account-button"
      aria-pressed={account.id === selectedId} onClick={() => onSelect(account.id)}>
      <div
        className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-white text-sm font-bold select-none${account.hidden ? ' opacity-40' : ''}`}
        style={{ backgroundColor: account.color }}
      >
        {account.initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-mail-text truncate flex items-center gap-1.5">
          <Private kind="name">{account.name}</Private>
          {account.oauth && (
            <Shield size={12} className="text-mail-accent-text flex-shrink-0" />
          )}
          {account.hidden && (
            <EyeOff size={12} className="text-mail-text-muted flex-shrink-0" />
          )}
        </div>
        <div className="text-xs text-mail-text-muted truncate">
          <Private kind="email">{account.email}</Private>
        </div>
      </div>
    </button>
  );
  return (
    <div ref={listRef} className="account-settings-list" style={style}>
      <div className="p-4">
        <div className="text-sm font-medium text-mail-text-muted mb-3">
          {t('settings.accounts.accounts')}
        </div>
        {accounts.length === 0 ? (
          <div className="text-center py-8 text-mail-text-muted">
            <Mail size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('common.noAccountsConfigured')}</p>
          </div>
        ) : sections.map((section, index) => {
          const label = section.name === null ? t('settings.accounts.accounts') : pa(section.name, 'name');
          return <section key={section.name ?? ''} className="account-settings-group">
            {section.name !== null && <div className="account-settings-group-header">
              <span><Private kind="name">{section.name}</Private></span>
              {onReorder && <>
                <button type="button" className="account-settings-group-move" disabled={sections[index - 1]?.name == null}
                  aria-label={t('settings.accounts.moveGroupUp', { name: label })} title={t('settings.accounts.moveGroupUp', { name: label })}
                  onClick={() => shiftGroup(section.name, -1)}>
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
                <button type="button" className="account-settings-group-move" disabled={index === sections.length - 1}
                  aria-label={t('settings.accounts.moveGroupDown', { name: label })} title={t('settings.accounts.moveGroupDown', { name: label })}
                  onClick={() => shiftGroup(section.name, 1)}>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              </>}
            </div>}
            {onReorder ? (
              <ReorderListView accounts={section.accounts} selectedAccountId={selectedId} onReorder={reorderable(section)}
                privateKind="email" labels={grouped ? { list: label } : undefined}>
                {row}
              </ReorderListView>
            ) : (
              <ol aria-label={label} className="account-settings-reorder-list">
                {section.accounts.map(account => (
                  <li key={account.id} data-account-id={account.id}
                    className={`account-settings-account ${account.id === selectedId ? 'account-settings-account-selected' : ''}`}>
                    {row(account)}
                  </li>
                ))}
              </ol>
            )}
          </section>;
        })}
        {onAdd && (
          <button
            onClick={onAdd}
            className="w-full mt-3 flex items-center justify-center gap-2 p-2.5 text-sm text-mail-text-muted
                      hover:text-mail-text hover:bg-mail-surface-hover border border-dashed border-mail-border
                      rounded-lg transition-all"
          >
            <Plus size={16} />
            {t('settings.accounts.addAccount')}
          </button>
        )}
        {footer}
      </div>
    </div>
  );
}

/**
 * The right column: the selected account's name, address and colour (`identity`: `{ name, email,
 * color, initial }`, null when none is selected), `saved` (the badge after a save), its `status`
 * line (`{ label, tone: 'error' | 'connected' | 'hidden' | 'idle', action: { label, disabled,
 * onClick } }`), and the four sections as tabs (`section`, `onSection`) holding `children`.
 */
export function AccountDetailView({ panelRef, identity, saved, status, section, onSection, children }) {
  const t = useT();
  const { Private } = useViewEnv();
  return (
    <div ref={panelRef} className="account-settings-detail">
      {identity ? (
        <>
          <header className="account-settings-identity">
            <div className="account-settings-identity-line">
              <span className="account-settings-avatar" aria-hidden="true"
                style={{ backgroundColor: identity.color }}>
                {identity.initial}
              </span>
              <div className="account-settings-identity-copy">
                <h3><Private kind="name">{identity.name}</Private></h3>
                <p><Private kind="email">{identity.email}</Private></p>
              </div>
              <SavedBadge visible={saved} />
            </div>
            <div role="status" className={`account-settings-status ${status.tone === 'error' ? 'account-settings-status-error' : ''}`}>
              {status.tone === 'error' ? <AlertCircle size={15} aria-hidden="true" />
                : status.tone === 'connected' ? <Check size={15} aria-hidden="true" />
                : status.tone === 'hidden' ? <EyeOff size={15} aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}
              <span>{status.label}</span>
              {status.action && <Button variant="subtle" size="sm" disabled={status.action.disabled}
                onClick={status.action.onClick}>
                {status.action.label}
              </Button>}
            </div>
          </header>
          <SettingsTabs value={section} onChange={onSection} label={t('settings.accounts.preferences')}
            tabs={[
              { id: 'profile', label: t('settings.accounts.sectionProfile') },
              { id: 'aliases', label: t('settings.accounts.sectionAliases') },
              { id: 'connection', label: t('settings.accounts.sectionConnection') },
              { id: 'advanced', label: t('settings.accounts.sectionAdvanced') },
            ]}>
            <p className="account-settings-section-intro">{t(`settings.accounts.${section}Intro`)}</p>
            {children}
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
  );
}

/**
 * Profile: the address (`emailLabel`, `email`), the name mail is sent with (`displayName`,
 * `onDisplayName`), `groupField` (desktop's account group), and the signature: on or off
 * (`signatureEnabled`, `onSignatureEnabled`) and its content, either `signatureEditor` (desktop's
 * rich editor with its hints) or a plain text field (`signatureText`, `onSignatureText`).
 */
export function AccountProfileView({
  emailLabel, email, displayName, onDisplayName, groupField = null,
  signatureEnabled, onSignatureEnabled, signatureEditor, signatureText, onSignatureText,
}) {
  const t = useT();
  const { privateAttr: pa, privateInputClass } = useViewEnv();
  return (
    <>
      {/* Account Info */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <User size={18} className="text-mail-accent-text" />
          {t('settings.accounts.accountSettings')}
        </h4>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-mail-text mb-2">
              {emailLabel}
            </label>
            <input aria-label={emailLabel}
              type="text"
              value={pa(email, 'email')}
              disabled
              className={`${FIELD}
                        text-mail-text-muted cursor-not-allowed`}
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
              dir="auto"
              value={displayName}
              onChange={(e) => onDisplayName(e.target.value)}
              placeholder={t('settings.accounts.johnDoe')}
              className={`${privateInputClass} ${FIELD}
                        text-mail-text placeholder-mail-text-muted
                        focus:border-mail-accent transition-all`}
            />
          </div>
          {groupField}
        </div>
      </div>

      {/* Signature */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <FileText size={18} className="text-mail-accent-text" />
          {t('settings.accounts.emailSignature')}
        </h4>

        <div className="space-y-4">
          <div className="account-settings-choice-row">
            <div>
              <div className="font-medium text-mail-text">{t('settings.accounts.enableSignature')}</div>
              <div className="text-sm text-mail-text-muted">
                {t('settings.accounts.automaticallyAddOutgoingEmails')}
              </div>
            </div>
            <div className="account-settings-choice-group" role="group" aria-label={t('settings.accounts.enableSignature')}>
              {[[true, 'yes'], [false, 'no']].map(([enabled, label]) => <button key={label} type="button"
                aria-pressed={!!signatureEnabled === enabled}
                onClick={() => onSignatureEnabled(enabled)}>{t(`views.tristate.${label}`)}</button>)}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-mail-text mb-2">
              {t('settings.accounts.signatureContent')}
            </label>
            {signatureEditor !== undefined ? signatureEditor : (
              <textarea aria-label={t('settings.accounts.signatureContent')}
                dir="auto"
                rows={5}
                value={signatureText}
                onChange={(e) => onSignatureText(e.target.value)}
                placeholder={t('settings.accounts.bestRegardsJohnDoe')}
                className={`${FIELD} text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all resize-y`}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Connection: `errorDetails` (the last connection error, folded), then authentication and, for a
 * password account, its mail servers, then the Sent folder.
 *
 * - `auth`: `{ oauth, provider ('Google' | 'Microsoft'), token (a JMAP API token), stored (a
 *   password is kept) }`. OAuth: `onReconnect`, `reconnecting`, and `oauthExtra` (desktop's
 *   Microsoft transport and Google sign-in switches). Password: `editingPassword`,
 *   `onEditPassword(bool)`, `newPassword`, `onNewPassword`, `onSavePassword`, `replaceLabel` (what
 *   the button and field say: a JMAP secret, or a password), `passwordBusy`, `passwordError`.
 * - `server`: null (an OAuth account), or `{ jmap: { sessionUrl, token, username } }` or
 *   `{ imap: { host, port, security }, smtp: { host, port } }`; `onChangeServer` (desktop opens its
 *   server dialog; the phone shows `serverForm` in place of the summary while `serverForm` is set).
 * - `sent`: null (the server files Sent copies itself), or `{ value, options: [{ path, label }],
 *   autoLabel, savedOverride, onChange, onSave, saving, onAutoCreate?, autoCreating }`.
 */
export function AccountConnectionView({
  errorDetails = null, auth, onReconnect, reconnecting = false, oauthExtra = null,
  editingPassword, onEditPassword, newPassword, onNewPassword, onSavePassword, replaceLabel, passwordBusy = false, passwordError = null,
  server = null, onChangeServer, serverForm = null, serverNote = null, sent = null,
}) {
  const t = useT();
  const { privateAttr: pa } = useViewEnv();
  const secretLabel = auth.token ? t('account.jmapApiToken') : t('settings.accounts.password');
  return (
    <>
      {errorDetails && (
        <details className="account-settings-error-details">
          <summary>{t('settings.accounts.technicalDetails')}</summary>
          <p>{errorDetails}</p>
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
            {auth.oauth ? (
              <><Shield size={12} /> {t('settings.accounts.providerOauth2', { provider: auth.provider })}</>
            ) : (
              <><Key size={12} /> {secretLabel}</>
            )}
          </span>
        </div>

        {auth.oauth ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-mail-text">{t('settings.accounts.providerAccount', { provider: auth.provider })}</div>
                <div className="text-sm text-mail-text-muted">
                  {t('settings.accounts.authenticatedViaOauth2TokensRefresh')}
                </div>
              </div>
              <button
                onClick={() => onReconnect()}
                disabled={reconnecting}
                className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                          text-mail-text rounded-lg transition-colors flex items-center gap-2
                          disabled:opacity-50"
              >
                {reconnecting ? (
                  <Loader size={16} className="animate-spin" />
                ) : (
                  <RefreshCw size={16} />
                )}
                {reconnecting ? t('settings.accounts.reconnecting') : t('settings.accounts.reconnect')}
              </button>
            </div>
            {oauthExtra}
          </div>
        ) : editingPassword ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-mail-text mb-2">
                {replaceLabel}
              </label>
              <input aria-label={replaceLabel}
                type="password"
                autoFocus
                value={newPassword}
                disabled={passwordBusy}
                onChange={(e) => onNewPassword(e.target.value)}
                placeholder={t('settings.accounts.enterEmailPassword')}
                className={`${FIELD}
                          text-mail-text placeholder-mail-text-muted
                          focus:border-mail-accent transition-all`}
              />
            </div>
            {passwordError && <p role="alert" className="text-sm text-mail-danger">{passwordError}</p>}
            <div className="flex gap-2">
              <button
                onClick={onSavePassword}
                disabled={!newPassword.trim() || passwordBusy}
                aria-busy={passwordBusy || undefined}
                className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover
                          text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {t('settings.accounts.savePassword')}
              </button>
              <button
                onClick={() => onEditPassword(false)}
                disabled={passwordBusy}
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
              <div className="font-medium text-mail-text">{secretLabel}</div>
              <div className="text-sm text-mail-text-muted">
                {auth.stored ? t('settings.accounts.storedSecurelySystemKeychain') : t('settings.accounts.configured')}
              </div>
            </div>
            {onEditPassword && <Button variant="subtle"
              onClick={() => onEditPassword(true)}
            >
              <Key size={16} />
              {auth.jmap ? t('account.jmapReplaceSecret')
                : auth.stored ? t('settings.accounts.update') : t('settings.accounts.setPassword')}
            </Button>}
          </div>
        )}
      </div>

      {/* Mail Server (password / IMAP accounts only) */}
      {server && (
        <div className="settings-section">
          <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
            <Server size={18} className="text-mail-accent-text" />
            {t('settings.accounts.mailServer')}
          </h4>

          <p className="text-sm text-mail-text-muted mb-4">
            {t('settings.accounts.changedHostingKeptSameAddress')}
          </p>

          {serverNote}
          {serverForm || (
            <div className="flex items-center justify-between">
              {server.jmap ? (
                <div className="text-sm text-mail-text-muted space-y-0.5 min-w-0" data-testid="jmap-server-details">
                  <div className="break-all">{t('account.jmapSessionUrl')} <code className="text-mail-text">{server.jmap.sessionUrl}</code></div>
                  <div>{server.jmap.token ? t('account.jmapApiToken') : t('settings.accounts.password')}</div>
                  {!server.jmap.token && (
                    <div>{t('account.jmapUsername')} <code className="text-mail-text">{pa(server.jmap.username, 'email')}</code></div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-mail-text-muted space-y-0.5">
                  <div>
                    {t('settings.accounts.imap')} <code className="text-mail-text">{server.imap.host || '-'}:{server.imap.port || 993}</code>
                    {server.imap.security && server.imap.security !== 'ssl' && (
                      <span className="ml-1">({server.imap.security.toUpperCase()})</span>
                    )}
                  </div>
                  <div>{t('settings.accounts.smtp')} <code className="text-mail-text">{server.smtp.host || '-'}:{server.smtp.port || 587}</code></div>
                </div>
              )}
              <button
                onClick={onChangeServer}
                className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border text-mail-text
                          rounded-lg transition-colors flex items-center gap-2 text-sm"
              >
                <Server size={16} />
                {t('settings.accounts.changeServer')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Sent Folder */}
      {sent && (
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
                value={sent.value}
                onChange={(e) => sent.onChange(e.target.value)}
                className={`${FIELD}
                          text-mail-text focus:border-mail-accent transition-all`}
              >
                <option value="">
                  {sent.autoLabel}
                </option>
                {sent.options.map(m => (
                  <option key={m.path} value={m.path}>{m.label}</option>
                ))}
              </select>
              {sent.savedOverride && (
                <p className="text-xs text-mail-text-muted mt-2">
                  {t('settings.accounts.currentSavedOverride')} <code className="text-mail-text">{sent.savedOverride}</code>
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={sent.onSave}
                disabled={sent.saving || sent.value === (sent.savedOverride || '')}
                className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover
                          text-white rounded-lg transition-colors text-sm font-medium
                          disabled:opacity-50"
              >
                {sent.saving ? t('settings.accounts.saving') : t('settings.accounts.saveSentFolder')}
              </button>
              {sent.onAutoCreate && (
                <button
                  onClick={sent.onAutoCreate}
                  disabled={sent.autoCreating}
                  className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border
                            text-mail-text rounded-lg transition-colors text-sm font-medium
                            flex items-center gap-2 disabled:opacity-50"
                  title={t('settings.accounts.askServerAutoDetectCreate')}
                >
                  {sent.autoCreating ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {sent.autoCreating ? t('settings.accounts.working') : t('settings.accounts.autoDetectCreate')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The phone's mail server form (desktop changes servers in its own account dialog): the password
 * (blank keeps the saved one) and the IMAP and SMTP servers. `values`: `{ password, imapHost,
 * imapPort, security, smtpHost, smtpPort, smtpSecurity }`; `onChange(patch)`; `onSave`,
 * `onCancel`; `busy`; `note`: the outcome (`{ error, text }`).
 */
export function AccountServerFormView({ values, onChange, onSave, onCancel, busy = false, note = null }) {
  const t = useT();
  const digits = v => v.replace(/\D/g, '').slice(0, 5);
  const ready = values.imapHost.trim() && Number(values.imapPort) > 0 && values.smtpHost.trim() && Number(values.smtpPort) > 0;
  const text = (key, label, extra = {}) => (
    <div>
      <label className="block text-sm font-medium text-mail-text mb-2">{label}</label>
      <input aria-label={label} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={values[key]} disabled={busy}
        onChange={e => onChange({ [key]: extra.inputMode === 'numeric' ? digits(e.target.value) : e.target.value })}
        className={`${FIELD} text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all`} {...extra} />
    </div>
  );
  const pick = (key, label, options) => (
    <div>
      <label className="block text-sm font-medium text-mail-text mb-2">{label}</label>
      <select aria-label={label} value={values[key]} disabled={busy} onChange={e => onChange({ [key]: e.target.value })}
        className={`${FIELD} text-mail-text focus:border-mail-accent transition-all`}>
        {options.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
      </select>
    </div>
  );
  return (
    <div className="space-y-4" data-testid="account-server-form">
      {text('password', t('settings.accounts.password'), { type: 'password', autoComplete: 'current-password', placeholder: t('mobile.accounts.server.keepPassword') })}
      {text('imapHost', t('mobile.add.host'), { inputMode: 'url' })}
      {text('imapPort', t('mobile.add.port'), { inputMode: 'numeric' })}
      {pick('security', t('account.security'), [['ssl', 'account.sslTls'], ['starttls', 'account.starttls'], ['none', 'account.none']])}
      {text('smtpHost', t('mobile.add.smtpHost'), { inputMode: 'url' })}
      {text('smtpPort', t('mobile.add.smtpPort'), { inputMode: 'numeric' })}
      {pick('smtpSecurity', t('mobile.add.smtpSecurity'), [['ssl', 'account.sslTls'], ['starttls', 'account.starttls']])}
      {note && <p role={note.error ? 'alert' : 'status'} className={`text-sm ${note.error ? 'text-mail-danger' : 'text-mail-text-muted'}`}>{note.text}</p>}
      <div className="flex gap-2">
        <button onClick={onSave} disabled={busy || !ready} aria-busy={busy || undefined}
          className="px-4 py-2 bg-mail-accent-fill hover:bg-mail-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
          {busy ? t('mobile.add.signingIn') : t('mobile.accounts.server.save')}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-4 py-2 bg-mail-surface-hover hover:bg-mail-border text-mail-text rounded-lg transition-colors">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * Advanced: the avatar colour (`colors`, `color`, `onColor`, `onResetColor` while a colour of its
 * own is set), `downloadMode` (desktop's per-account download mode), visible or hidden (`hidden`,
 * `onHidden(bool)`, `onEyeClick`), and Remove (`remove`: `{ confirming, onAsk, onCancel,
 * onConfirm, removing, error, question, warning, confirmLabel, revoke }`; `revoke` is
 * `{ checked, onChange(bool) }` for an account whose Google grant can be revoked, else null).
 */
export function AccountAdvancedView({ colors, color, onColor, onResetColor, downloadMode = null, hidden, onHidden, onEyeClick, remove, copy = {} }) {
  const t = useT();
  return (
    <>
      <div className="settings-section">
        {/* Avatar Color */}
        <div>
          <label className="block text-sm font-medium text-mail-text mb-2">
            {t('settings.accounts.avatarColor')}
          </label>
          <p className="text-sm text-mail-text-muted mb-2">
            {copy.colorHint ?? t('settings.accounts.colorUsedAccountAvatarSidebar')}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {colors.map(option => {
              const isSelected = color === option;
              return (
                <button
                  key={option}
                  onClick={() => onColor(option)}
                  className={`w-7 h-7 rounded-full transition-all ${
                    isSelected ? 'ring-2 ring-offset-2 ring-offset-mail-bg' : 'hover:scale-110'
                  }`}
                  style={{
                    backgroundColor: option,
                    '--tw-ring-color': option
                  }}
                  title={option}
                  aria-label={`${t('settings.accounts.avatarColor')}: ${option}`} aria-pressed={isSelected}
                />
              );
            })}
            {onResetColor && (
              <button
                onClick={onResetColor}
                className="text-xs text-mail-text-muted hover:text-mail-text transition-colors ml-1"
                title={t('common.resetToDefault')}
              >
                {t('common.reset')}
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Download mode override (the default lives in Settings > Storage) */}
      {downloadMode && (
        <div className="settings-section">
          <h4 className="font-semibold text-mail-text mb-2 flex items-center gap-2">
            <HardDrive size={18} className="text-mail-accent-text" />
            {t('settings.storage.downloadMode')}
          </h4>
          <p className="text-sm text-mail-text-muted mb-3">{t('settings.accounts.downloadModeHint')}</p>
          {downloadMode}
        </div>
      )}
      {/* Hide Account */}
      <div className="settings-section">
        <div className="account-settings-choice-row">
          <div className="flex items-center gap-3">
            <span data-testid="account-visibility-eye" onClick={onEyeClick}>
              {hidden ? (
                <EyeOff size={18} className="text-mail-text-muted" />
              ) : (
                <Eye size={18} className="text-mail-accent-text" />
              )}
            </span>
            <div>
              <div className="font-medium text-mail-text">
                {hidden ? t('settings.accounts.accountHidden') : t('settings.accounts.accountVisible')}
              </div>
              <div className="text-sm text-mail-text-muted">
                {copy.hiddenHint ?? t('settings.accounts.hiddenAccountsRemovedSidebarStop')}
              </div>
            </div>
          </div>
          <div className="account-settings-choice-group" role="group" aria-label={t('settings.accounts.accountVisible')}>
            {[false, true].map(value => <button key={String(value)} type="button"
              aria-pressed={hidden === value}
              onClick={() => { if (hidden !== value) onHidden(value); }}>
              {t(value ? 'settings.accounts.accountHidden' : 'settings.accounts.accountVisible')}
            </button>)}
          </div>
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
          onClick={remove.onAsk}
        >
          <Trash2 size={16} />
          {t('settings.accounts.removeAccount2')}
        </Button>

        <AnimatePresence>
          {remove.confirming && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden mt-4"
            >
              <div className="bg-mail-danger/5 border border-mail-danger/30 rounded-lg p-4" data-testid="account-remove-confirm">
                <p className="text-sm text-mail-text mb-1 font-medium">
                  {remove.question}
                </p>
                <p className="text-sm text-mail-text-muted mb-2">
                  {t('settings.accounts.removeAccountExplanation')}
                </p>
                {remove.warning && (
                  <p className="text-sm text-mail-warning mb-2">
                    {remove.warning}
                  </p>
                )}
                {remove.revoke && (
                  <label className="flex items-start gap-2 mt-2 text-sm text-mail-text cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={remove.revoke.checked}
                      disabled={remove.removing}
                      onChange={e => remove.revoke.onChange(e.target.checked)} />
                    <span>
                      {t('settings.accounts.revokeGoogle')}
                      <span className="block text-xs text-mail-text-muted mt-0.5">{t('settings.accounts.revokeGoogleHint')}</span>
                    </span>
                  </label>
                )}
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={remove.onConfirm}
                    disabled={remove.removing}
                    className="px-4 py-2 bg-mail-danger hover:bg-mail-danger/80
                              text-white rounded-lg transition-colors text-sm font-medium"
                  >
                    {remove.confirmLabel}
                  </button>
                  <button
                    onClick={remove.onCancel}
                    disabled={remove.removing}
                    className="px-4 py-2 bg-mail-border hover:bg-mail-border/80
                              text-mail-text rounded-lg transition-colors text-sm"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
                {remove.error && <p role="alert" className="mt-3 text-sm text-mail-danger">
                  {remove.error}
                </p>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
