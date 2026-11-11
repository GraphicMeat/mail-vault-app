// The tour's account step: "Import from computer" first (the accounts of MailVault on the
// computer, by its set-up QR code: ImportFromDesktop), "Add account manually" second (the provider
// picker of AddAccount, without its own import entry), and "I'll do this later" in the tour's
// Continue place. Either flow takes the whole screen; its Back comes back here. An import that
// added accounts opens the first one and the tour carries on; one that added nothing stays here.
import React, { useState } from 'react';
import { useT } from '../i18n.js';
import { useMobileStore } from '../store.js';
import ImportFromDesktop from '../ImportFromDesktop.jsx';
import AddAccount from '../AddAccount.jsx';

export default function AccountStep({ flow, onFlow, onAdd, onOAuth, onOAuthCancel, onAdded }) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  if (flow === 'import') {
    return (
      <ImportFromDesktop
        onImport={(request) => useMobileStore.getState().importFromDesktop(request)}
        onCancel={() => onFlow(null)}
        onDone={async ({ imported } = {}) => {
          if (!imported?.length) {
            onFlow(null);
            return;
          }
          setBusy(true);
          try {
            await useMobileStore.getState().openImported(imported);
          } finally {
            setBusy(false);
          }
          onFlow(null);
          onAdded();
        }}
      />
    );
  }

  if (flow === 'manual') {
    const done = (result) => {
      if (result?.ok) {
        onFlow(null);
        onAdded();
      }
      return result;
    };
    return (
      <AddAccount
        onSubmit={async (form) => done(await onAdd(form))}
        onOAuth={onOAuth ? async (provider) => done(await onOAuth(provider)) : undefined}
        onOAuthCancel={onOAuthCancel}
        onCancel={() => onFlow(null)}
      />
    );
  }

  return (
    <>
      <h1 className="mv-tour__title">{t('mobile.onboarding.accountTitle')}</h1>
      <p className="mv-tour__lead">{t('mobile.onboarding.accountLead')}</p>
      <div className="mv-tour__choices">
        <button type="button" className="mv-primary" disabled={busy} onClick={() => onFlow('import')}>
          {t('mobile.import.entry')}
        </button>
        <button type="button" className="mv-provider" disabled={busy} onClick={() => onFlow('manual')}>
          {t('mobile.onboarding.addManually')}
        </button>
      </div>
    </>
  );
}
