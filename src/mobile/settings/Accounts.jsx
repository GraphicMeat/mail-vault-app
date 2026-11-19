// Settings > Accounts on the phone: desktop's account views (src/components/settings/views/
// AccountsView.jsx, AliasesView.jsx) over the phone's engine. The account list (Add account opens
// the phone's own sign-in flow), then the selected account (the first one at first): its name,
// address and status, and desktop's four sections as tabs.
//
// Each account's own settings are `mobile.accountSettings.*` rows (account_settings.rs), written as
// desktop writes them: the name and the signature a moment after typing stops (and when the page
// goes), every other choice at once; the accounts are re-read after a write that shows in the list.
//
// - Profile: the name mail is sent with, the signature switch ("Automatically add to outgoing
//   emails", the account's own `signature.enabled`) and its text. The phone sends plain text: a
//   signature imported from desktop shows as its text and keeps its html until the text changes.
// - Aliases: the addresses compose can send from (`aliases`, each with the name recipients see) and
//   the default From (`sendAs`, '' for the login); the engine checks every From against them. The
//   provider lookup, Verify and an alias's own signature are desktop's (the engine has none).
// - Connection: an OAuth account's Reconnect is the store's reauth. A password IMAP account's
//   password and servers go through `mobile.accounts.update`, which signs in with them before it
//   keeps them (a blank password keeps the saved one); the password leaves the screen once saved.
//   The Sent folder (IMAP only: Graph and JMAP servers file the Sent copy themselves): found
//   automatically, or one of the account's folders (`mobile.folders.list`).
// - Advanced: the avatar colour (desktop's palette, or automatic), hidden (out of the switcher, the
//   drawer and All Inboxes, still listed here), and Remove after desktop's question.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccountListView, AccountDetailView, AccountProfileView, AccountConnectionView, AccountAdvancedView,
  AccountServerFormView, ACCOUNT_SECTIONS,
} from '../../components/settings/views/AccountsView';
import { AliasesView } from '../../components/settings/views/AliasesView';
import { AccountTransferView } from '../../components/settings/views/AccountTransferView';
import { Button } from '../../components/ui/Button';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { errorKey } from '../errors.js';
import { htmlToText } from '../prefs.js';
import { ACCOUNT_COLORS, accountColor } from '../accountColor.js';
import { initialOf } from '../AccountSwitcher.jsx';
import { folderLabel } from '../folders.js';
import { MobileViewEnv } from './MobileViewEnv.jsx';

const SAVE_DELAY_MS = 400;
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

/** Whether `account` signs in with a password over IMAP: the only kind whose servers change here. */
export function hasServerSettings(account) {
  return account?.oauth === false && (account.kind || 'imap') === 'imap';
}

/** Whether the phone files `account`'s Sent copy itself (over IMAP), so the folder can be picked. */
export function picksSentFolder(account) {
  return (account?.kind || 'imap') === 'imap';
}

const signatureText = (sig) => (sig ? (sig.text || htmlToText(sig.html)) : '');

/**
 * One account's settings (`mobile.accountSettings.get`), and `write(values)` that keeps them. The
 * values are kept with the account they were read for and only that account's are handed out, so a
 * write or a read that lands after a switch never fills another account's form. `loadFailed` with
 * `retry()` when the read failed; `saveFailed` when the last write of this account was refused.
 */
function useAccountSettings(accountId, onSaved) {
  const [got, setGot] = useState({ id: null, values: null });
  const [loadFailed, setLoadFailed] = useState(null);
  const [saveFailed, setSaveFailed] = useState(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    if (!accountId) return undefined;
    daemonCall('mobile.accountSettings.get', { accountId }).then(
      (v) => {
        if (!live) return;
        setGot({ id: accountId, values: v || {} });
        setLoadFailed(null);
      },
      () => { if (live) setLoadFailed(accountId); },
    );
    return () => { live = false; };
  }, [accountId, tries]);
  const write = useCallback(async (patch) => {
    try {
      const next = await daemonCall('mobile.accountSettings.set', { accountId, values: patch });
      setGot((g) => (g.id === accountId && next ? { id: accountId, values: next } : g));
      setSaveFailed((f) => (f === accountId ? null : f));
      onSaved(patch);
      return true;
    } catch {
      setSaveFailed(accountId);
      return false;
    }
  }, [accountId, onSaved]);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  return {
    values: accountId && got.id === accountId ? got.values : null,
    write,
    loadFailed: Boolean(accountId) && loadFailed === accountId,
    saveFailed: Boolean(accountId) && saveFailed === accountId,
    retry,
  };
}

/** The account's folders (`mobile.folders.list`), selectable ones only. */
function useFolders(accountId, wanted) {
  const [folders, setFolders] = useState([]);
  useEffect(() => {
    let live = true;
    setFolders([]);
    if (!accountId || !wanted) return undefined;
    daemonCall('mobile.folders.list', { accountId }).then(
      (r) => { if (live) setFolders((r?.folders || []).filter((f) => !f.noselect)); },
      () => {},
    );
    return () => { live = false; };
  }, [accountId, wanted]);
  return folders;
}

function Profile({ account, settings, write }) {
  const t = useT();
  const [name, setName] = useState(settings.displayName && settings.displayName !== account.email ? settings.displayName : '');
  const [text, setText] = useState(signatureText(settings.signature));
  const latest = useRef({ name, text });
  latest.current = { name, text };
  const saved = useRef({ name, text });
  const timer = useRef(null);
  // The latest stored signature and writer: a flush late after a switch tap keeps the switch.
  const current = useRef({ signature: settings.signature, write });
  current.current = { signature: settings.signature, write };

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const now = latest.current;
    const before = saved.current;
    const values = {};
    if (now.name.trim() !== before.name.trim()) values.displayName = now.name.trim();
    if (now.text.trim() !== before.text.trim()) {
      const sig = current.current.signature;
      // A changed text replaces the html: compose sends plain text.
      values.signature = now.text.trim()
        ? { html: '', text: now.text.trim(), enabled: sig ? sig.enabled !== false : true }
        : (sig ? { html: '', text: '', enabled: sig.enabled !== false } : null);
    }
    if (!Object.keys(values).length) return;
    saved.current = now;
    current.current.write(values);
  }, []);
  const later = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };
  useEffect(() => () => { if (timer.current) flush(); }, [flush]);

  const sig = settings.signature;
  return (
    <AccountProfileView emailLabel={t('account.emailAddress')} email={account.email}
      displayName={name} onDisplayName={(v) => { setName(v.slice(0, 200)); later(); }}
      signatureEnabled={sig ? sig.enabled !== false : true}
      onSignatureEnabled={(enabled) => write({ signature: { html: sig?.html || '', text: sig?.text || signatureText(sig), enabled } })}
      signatureText={text} onSignatureText={(v) => { setText(v); later(); }} />
  );
}

function Aliases({ account, settings, write }) {
  const aliases = Array.isArray(settings.aliases) ? settings.aliases : [];
  const sendAs = settings.sendAs || '';
  const name = settings.displayName && settings.displayName !== account.email ? settings.displayName : '';
  const list = (next) => next.map((a) => ({ address: a.address, name: (a.name || '').trim() }));
  return (
    <AliasesView accountId={account.id} login={account.email} accountName={name} aliases={aliases} defaultFrom={sendAs}
      onAdd={async (address, aliasName) => {
        const a = address.trim();
        if (!looksLikeEmail(a)) return { ok: false, reason: 'invalid' };
        if (same(a, account.email)) return { ok: false, reason: 'login' };
        if (aliases.some((x) => same(x.address, a))) return { ok: false, reason: 'duplicate' };
        const ok = await write({ aliases: list([...aliases, { address: a, name: aliasName }]) });
        // Refused: the field keeps the address; the page says the save failed.
        return ok ? { ok: true } : { ok: false, reason: null };
      }}
      onRemove={(address) => write({
        aliases: list(aliases.filter((x) => !same(x.address, address))),
        // The default goes back to the login with the alias it named.
        ...(same(sendAs, address) ? { sendAs: '' } : {}),
      })}
      onDefault={(address) => write({ sendAs: address })}
      onRename={(address, aliasName) => write({ aliases: list(aliases.map((x) => (same(x.address, address) ? { ...x, name: aliasName } : x))) })} />
  );
}

function Connection({ account, settings, write, editingPassword, setEditingPassword }) {
  const t = useT();
  const reauthState = useMobileStore((s) => s.reauthState);
  const servers = hasServerSettings(account);
  const sentPicked = picksSentFolder(account);
  const folders = useFolders(account.id, sentPicked);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { error, text }
  const [serverOpen, setServerOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [sent, setSent] = useState(settings.sentFolder || '');
  const [savingSent, setSavingSent] = useState(false);
  useEffect(() => setSent(settings.sentFolder || ''), [settings.sentFolder]);

  // `mobile.accounts.update`: signs in with the values first and keeps nothing that was refused.
  const update = async (fields) => {
    setBusy(true);
    setNote(null);
    let reply;
    try {
      reply = await daemonCall('mobile.accounts.update', { accountId: account.id, ...fields });
    } catch (err) {
      reply = { ok: false, code: err?.code || 'INTERNAL' };
    }
    setBusy(false);
    if (reply?.ok) {
      useMobileStore.getState().reloadAccounts?.();
      return true;
    }
    setNote({ error: true, text: t(errorKey(reply?.code || 'INTERNAL') || 'mobile.settings.saveFailed') });
    return false;
  };
  const current = {
    imapHost: account.imapHost || '', imapPort: Number(account.imapPort) || 0, security: account.security || 'ssl',
    smtpHost: account.smtpHost || '', smtpPort: Number(account.smtpPort) || 0, smtpSecurity: account.smtpSecurity === 'starttls' ? 'starttls' : 'ssl',
  };
  const savePassword = async () => {
    if (await update({ password, ...current })) {
      setPassword('');
      setEditingPassword(false);
    }
  };
  const openServer = () => {
    setForm({ password: '', ...current, imapPort: String(current.imapPort || ''), smtpPort: String(current.smtpPort || '') });
    setNote(null);
    setServerOpen(true);
  };
  const saveServer = async () => {
    const ok = await update({
      password: form.password, imapHost: form.imapHost.trim(), imapPort: Number(form.imapPort), security: form.security,
      smtpHost: form.smtpHost.trim(), smtpPort: Number(form.smtpPort), smtpSecurity: form.smtpSecurity,
    });
    if (ok) {
      setServerOpen(false);
      setForm(null);
      setNote({ error: false, text: t('mobile.accounts.server.saved') });
    }
  };

  const paths = folders.map((f) => ({ path: f.path, label: folderLabel(f) }));
  if (sent && !paths.some((f) => f.path === sent)) paths.push({ path: sent, label: sent });
  return (
    <AccountConnectionView
      auth={{
        oauth: account.oauth !== false,
        provider: account.provider === 'google' || account.provider === 'gmail' ? 'Google' : 'Microsoft',
        stored: true,
      }}
      onReconnect={() => useMobileStore.getState().reauth(account.id)}
      reconnecting={Boolean(reauthState?.busy && reauthState.accountId === account.id)}
      editingPassword={editingPassword}
      onEditPassword={servers ? (editing) => { setEditingPassword(editing); if (!editing) setPassword(''); setNote(null); } : undefined}
      newPassword={password} onNewPassword={setPassword} onSavePassword={savePassword}
      replaceLabel={t('settings.accounts.newPassword')} passwordBusy={busy} passwordError={editingPassword && note?.error ? note.text : null}
      server={servers ? {
        imap: { host: account.imapHost, port: account.imapPort, security: account.security },
        smtp: { host: account.smtpHost, port: account.smtpPort },
      } : null}
      onChangeServer={openServer}
      serverForm={serverOpen && form ? (
        <AccountServerFormView values={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          onSave={saveServer} onCancel={() => { setServerOpen(false); setForm(null); setNote(null); }}
          busy={busy} note={!editingPassword ? note : null} />
      ) : null}
      serverNote={!serverOpen && !editingPassword && note && !note.error ? <p role="status" className="text-sm text-mail-text-muted mb-3">{note.text}</p> : null}
      sent={sentPicked ? {
        value: sent, options: paths, autoLabel: t('mobile.accounts.sentFolderAuto'), savedOverride: settings.sentFolder || null,
        onChange: setSent, saving: savingSent,
        onSave: async () => {
          setSavingSent(true);
          await write({ sentFolder: sent || null });
          setSavingSent(false);
        },
      } : null} />
  );
}

function Advanced({ account, settings, write, onRemoved }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);
  const own = typeof settings.color === 'string' ? settings.color : null;
  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await useMobileStore.getState().removeAccount(account.id);
      onRemoved();
    } catch {
      // Refused: the question stays for another try.
      setError(t('settings.accounts.removeFailed'));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <AccountAdvancedView colors={ACCOUNT_COLORS} color={accountColor({ ...account, color: own })}
      onColor={(color) => write({ color })} onResetColor={own ? () => write({ color: null }) : undefined}
      hidden={Boolean(settings.hidden)} onHidden={(hidden) => write({ hidden })}
      copy={{ colorHint: t('mobile.accounts.colorHint'), hiddenHint: t('mobile.accounts.hiddenHint') }}
      remove={{
        confirming, removing, error,
        onAsk: () => { setError(null); setConfirming(true); },
        onCancel: () => setConfirming(false),
        onConfirm: remove,
        question: t('settings.accounts.sureRemoveAccount', { email: account.email }),
        confirmLabel: t('common.remove'),
      }} />
  );
}

/**
 * `section` / `onSectionChange`: the open section (the shell's, so a search result lands on it).
 * `onAddAccount`: the phone's own sign-in flow. `onExport`: desktop's "Move to another computer"
 * Export under the list, the phone's transfer page.
 */
export default function Accounts({ section: sectionProp, onSectionChange, onAddAccount, onExport }) {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const reauthState = useMobileStore((s) => s.reauthState);
  const syncState = useMobileStore((s) => s.syncState);
  const [selectedId, setSelectedId] = useState(accounts[0]?.id || null);
  // The list sits over the selected account on the phone: a tap brings that account into view.
  const layout = useRef(null);
  const reveal = useRef(false);
  const pick = (id) => { reveal.current = true; setSelectedId(id); };
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    layout.current?.querySelector('.account-settings-detail')?.scrollIntoView?.({ block: 'start' });
  }, [selectedId]);
  const [savedAt, setSavedAt] = useState(0);
  const [editingPassword, setEditingPassword] = useState(false);
  const section = ACCOUNT_SECTIONS.includes(sectionProp) ? sectionProp : 'profile';
  const account = accounts.find((a) => a.id === selectedId) || null;

  useEffect(() => {
    if (!accounts.some((a) => a.id === selectedId)) setSelectedId(accounts[0]?.id || null);
  }, [accounts, selectedId]);
  useEffect(() => setEditingPassword(false), [selectedId]);
  useEffect(() => {
    if (!savedAt) return undefined;
    const timer = setTimeout(() => setSavedAt(0), 1500);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const onSaved = useCallback((patch) => {
    setSavedAt(Date.now());
    if ('displayName' in patch || 'color' in patch || 'hidden' in patch) useMobileStore.getState().reloadAccounts();
  }, []);
  const { values: settings, write, loadFailed, saveFailed, retry } = useAccountSettings(account?.id, onSaved);

  const sync = account ? syncState?.[account.id] : null;
  const reconnecting = Boolean(reauthState?.busy && reauthState.accountId === account?.id);
  const status = !account ? null
    : account.hidden ? { label: t('settings.accounts.accountHidden'), tone: 'hidden' }
    : account.needsAuth && account.oauth !== false ? {
      label: t('settings.accounts.reconnectRequired'), tone: 'error',
      action: { label: reconnecting ? t('settings.accounts.reconnecting') : t('settings.accounts.reconnect'), disabled: reconnecting, onClick: () => useMobileStore.getState().reauth(account.id) },
    }
    : account.authRefused && hasServerSettings(account) ? {
      label: t('settings.accounts.passwordRequired'), tone: 'error',
      action: { label: t('settings.accounts.enterPassword'), onClick: () => { onSectionChange('connection'); setEditingPassword(true); } },
    }
    : sync?.state === 'error' ? { label: t(sync.code === 'OFFLINE' ? 'sidebar.noInternet' : 'settings.accounts.connectionFailed'), tone: 'error' }
    : sync?.state === 'syncing' ? { label: t('sidebar.connecting'), tone: 'idle' }
    : { label: t('settings.accounts.connected'), tone: 'connected' };

  const props = account && settings ? { account, settings, write } : null;
  return (
    <MobileViewEnv>
      <div ref={layout} className="account-settings-layout">
        <AccountListView
          accounts={accounts.map((a) => ({
            id: a.id, email: a.email, initial: initialOf(a), color: accountColor(a), hidden: Boolean(a.hidden), oauth: a.oauth !== false,
            name: a.displayName && a.displayName !== a.email ? a.displayName : a.email.split('@')[0],
          }))}
          selectedId={selectedId} onSelect={pick} onAdd={onAddAccount}
          footer={<AccountTransferView accounts={accounts} onExportAccounts={onExport} />} />
        <AccountDetailView
          identity={account ? {
            name: account.displayName || account.email, email: account.email, color: accountColor(account), initial: initialOf(account),
          } : null}
          saved={Boolean(savedAt)} status={status || { label: '', tone: 'idle' }} section={section} onSection={onSectionChange}>
          {saveFailed && <p className="text-xs text-mail-danger" role="alert">{t('mobile.settings.saveFailed')}</p>}
          {account && !settings && loadFailed && (
            <div className="flex flex-wrap items-center gap-2" role="alert">
              <p className="text-xs text-mail-danger">{t('mobile.settings.loadFailed')}</p>
              <Button variant="secondary" size="sm" onClick={retry}>{t('common.retry')}</Button>
            </div>
          )}
          {account && !settings && !loadFailed && <div aria-busy="true" />}
          {props && section === 'profile' && <Profile key={account.id} {...props} />}
          {props && section === 'aliases' && <Aliases key={account.id} {...props} />}
          {props && section === 'connection' && (
            <Connection key={account.id} {...props} editingPassword={editingPassword} setEditingPassword={setEditingPassword} />
          )}
          {props && section === 'advanced' && <Advanced key={account.id} {...props} onRemoved={() => setSelectedId(null)} />}
        </AccountDetailView>
      </div>
    </MobileViewEnv>
  );
}
