import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { addAlias as addAliasFor, refreshAliases, removeAlias as removeAliasFor } from '../../services/aliases';
import { SendAsVerifyModal } from './SendAsVerifyModal';
import { SignatureImageSize } from './SignatureImageSize';
import { SignatureEditor } from './SignatureEditor';
import { textToHtml, htmlToText } from '../RichTextEditor';
import { signatureHasContent } from '../../utils/signatureImages';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr } from '../../hooks/usePrivacy';
import { isJmapAccount } from '../../services/providerKind';
import { DesktopViewEnv } from './DesktopViewEnv';
import { AliasesView } from './views/AliasesView';

// Settings > Accounts > Aliases (desktop's container over views/AliasesView.jsx): every address
// one account sends from. The
// login comes first and always stays; the aliases after it are the daemon's
// list, mirrored in the settings store (services/aliases.js; the daemon fills
// it from the provider and from the account's own mail, the user adds the
// rest). The radio column is
// the default From (`sendAsAddresses`, '' = the login); compose can still
// pick any of them per message. An alias signs with the account's signature
// unless it holds one of its own (`alias.signature`, see AliasSignature).

const NO_ALIASES = [];
const STATUS_KEYS = {
  ok: 'settings.accounts.aliases.status.ok',
  unsupported: 'settings.accounts.aliases.status.unsupported',
  denied: 'settings.accounts.aliases.status.denied',
  error: 'settings.accounts.aliases.status.error',
};
const NAME_SAVE_DELAY_MS = 400;

const key = address => (address || '').trim().toLowerCase();

/** Whether the daemon can ask the provider itself (src-core aliases::is_gmail_oauth). */
function isGoogleSignIn(account) {
  const text = value => (value || '').trim().toLowerCase();
  if (text(account?.authType) !== 'oauth2' || text(account?.oauth2Transport) === 'graph') return false;
  const host = text(account?.imapHost);
  return text(account?.oauth2Provider) === 'google' || host === 'imap.gmail.com' || host === 'imap.googlemail.com';
}

// This session's lookups, kept across the section closing and reopening:
// accountId -> { suggestions, providerStatus }. Suggestions are never stored
// anywhere else; the next session looks again.
const lookups = new Map();
/** Accounts whose automatic lookup this session has started. */
const asked = new Set();
/** Accounts with a lookup running now. */
const pending = new Set();

/** Test seam: forget this session's lookups. */
export function _resetAliasesSection() {
  lookups.clear();
  asked.clear();
  pending.clear();
}

export function AliasesSection({ account, displayName = '' }) {
  const t = useT();
  const accountId = account.id;
  const login = account.email || '';
  const stored = useSettingsStore(s => s.aliases?.[accountId]) || NO_ALIASES;
  const defaultFrom = useSettingsStore(s => s.sendAsAddresses?.[accountId]) || '';
  // A default From saved before aliases existed can have put the login here.
  const aliases = useMemo(
    () => stored.filter(alias => key(alias?.address) && key(alias.address) !== key(login)),
    [stored, login]
  );
  const accountName = displayName || (account.name && key(account.name) !== key(login) ? account.name : '');

  const [lookup, setLookup] = useState(() => lookups.get(accountId) || null);
  const [runningFor, setRunningFor] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const accountRef = useRef(account);
  accountRef.current = account;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const running = runningFor === accountId;

  // refreshAliases never rejects. An answer for an account the user has left
  // is kept for when they come back, and not shown on this one.
  const lookFor = useCallback(() => {
    const target = accountRef.current;
    const id = target.id;
    pending.add(id);
    setRunningFor(id);
    refreshAliases(target).then(result => {
      const answer = { suggestions: result?.suggestions || [], providerStatus: result?.providerStatus || 'error' };
      lookups.set(id, answer);
      pending.delete(id);
      if (!mounted.current || accountRef.current?.id !== id) return;
      setLookup(answer);
      setRunningFor(current => (current === id ? null : current));
    });
  }, []);

  // Opening the section looks once per account per session.
  useEffect(() => {
    setLookup(lookups.get(accountId) || null);
    setRunningFor(pending.has(accountId) ? accountId : null);
    setVerifying(null);
    if (asked.has(accountId)) return;
    asked.add(accountId);
    lookFor();
  }, [accountId, lookFor]);

  const listed = new Set([key(login), ...aliases.map(alias => key(alias.address))]);
  const suggestions = (lookup?.suggestions || []).filter(s => key(s?.address) && !listed.has(key(s.address)));
  const status = running ? 'running' : lookup ? lookup.providerStatus : 'idle';
  const statusText = running ? t('settings.accounts.aliases.looking')
    : lookup ? t(STATUS_KEYS[lookup.providerStatus] || STATUS_KEYS.error) : '';

  // The daemon keeps the list (aliases.add / aliases.remove). A JMAP server
  // lists its identities (aliases.refresh asks it, with the account's
  // password or token), as Google does.
  return (
    <DesktopViewEnv>
      <AliasesView accountId={accountId} login={login} accountName={accountName} aliases={aliases} defaultFrom={defaultFrom}
        onAdd={(address, name) => addAliasFor(account, { address, name, source: 'manual' })}
        onRemove={address => removeAliasFor(account, address)}
        onDefault={address => useSettingsStore.getState().setSendAsAddress(accountId, address)}
        onRename={(address, name) => useSettingsStore.getState().updateAlias(accountId, address, { name })}
        hint={isJmapAccount(account) ? t('settings.accounts.aliases.hintJmap')
          : t(isGoogleSignIn(account) ? 'settings.accounts.aliases.hintGmail' : 'settings.accounts.aliases.hintOther')}
        onRefresh={lookFor} running={running} status={status} statusText={statusText}
        suggestions={suggestions}
        onAddSuggestion={suggestion => { void addAliasFor(account, { address: suggestion.address, name: suggestion.name || '', source: 'detected' }); }}
        showSource onVerify={setVerifying}
        renderSignature={alias => <AliasSignature accountId={accountId} alias={alias} />}
        dialog={verifying && (
          <SendAsVerifyModal
            isOpen
            account={account}
            sendAsAddress={verifying.address}
            displayName={verifying.name || accountName}
            onClose={() => setVerifying(null)}
          />
        )} />
    </DesktopViewEnv>
  );
}

const signatureHtmlOf = signature => signature?.html || textToHtml(signature?.text || '');

/**
 * Which signature mail from one alias carries: the account's, or its own.
 * Own starts as a copy of the account's, since an alias usually differs from
 * it by a line. The editor is only mounted for an alias that has its own, so a
 * long alias list does not run one editor per row.
 */
function AliasSignature({ accountId, alias }) {
  const t = useT();
  const pa = usePrivateAttr();
  const own = !!alias.signature;
  const useOwn = () => {
    const account = useSettingsStore.getState().getSignature(accountId);
    useSettingsStore.getState().updateAlias(accountId, alias.address, { signature: { html: account.html || '', text: account.text || '' } });
  };
  const useAccount = () => useSettingsStore.getState().updateAlias(accountId, alias.address, { signature: null });
  return (
    <div className="alias-signature mt-3" data-testid="alias-signature">
      <div className="account-settings-choice-row">
        <span className="text-xs text-mail-text-muted">{t('settings.accounts.aliases.signatureLabel')}</span>
        <div className="account-settings-choice-group" role="group" aria-label={t('settings.accounts.aliases.signatureFor', { address: pa(alias.address, 'email') })}>
          <button type="button" aria-pressed={!own} data-testid="alias-signature-account" onClick={useAccount}>
            {t('settings.accounts.aliases.signatureAccount')}
          </button>
          <button type="button" aria-pressed={own} data-testid="alias-signature-own" onClick={useOwn}>
            {t('settings.accounts.aliases.signatureOwn')}
          </button>
        </div>
      </div>
      {own && <AliasSignatureEditor accountId={accountId} alias={alias} />}
    </div>
  );
}

/** The alias's own signature. Saved a moment after typing stops and when the editor goes away. */
function AliasSignatureEditor({ accountId, alias }) {
  const t = useT();
  const [html, setHtml] = useState(() => signatureHtmlOf(alias.signature));
  const latest = useRef(html);
  const timer = useRef(null);

  const save = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const store = useSettingsStore.getState();
    // Handed back to the account, or the alias is gone: nothing to write.
    const current = (store.aliases?.[accountId] || []).find(a => key(a?.address) === key(alias.address))?.signature;
    if (!current) return;
    const text = htmlToText(latest.current);
    const kept = signatureHasContent(latest.current, text) ? latest.current : '';
    if (kept === (current.html || '') && text === (current.text || '')) return;
    store.updateAlias(accountId, alias.address, { signature: { html: kept, text } });
  }, [accountId, alias.address]);

  useEffect(() => () => { if (timer.current) save(); }, [save]);

  return (
    <div className="mt-2">
      <SignatureEditor
        html={html}
        heightClass="h-40"
        boxTestId="alias-signature-editor"
        onChange={next => {
          latest.current = next;
          setHtml(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(save, NAME_SAVE_DELAY_MS);
        }}
        placeholder={t('settings.accounts.bestRegardsJohnDoe')}
      />
      <p className="text-xs text-mail-text-muted mt-2">{t('settings.accounts.aliases.signatureOwnHint')}</p>
      <SignatureImageSize html={html} />
    </div>
  );
}
