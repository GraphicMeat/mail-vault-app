// Settings > Search index (desktop's Storage > Search index, as far as it holds on a phone): the
// index of mail on this phone that search reads (engine `search.rs`). "Index message bodies"
// (`searchIndexBodies`) keeps the words of downloaded messages in it or only subjects and senders;
// "Index attachment text" (`searchIndexAttachments`, Premium as on desktop) adds the text of text
// and Office attachments once they are on the phone (`search_attach.rs`): without Premium the row
// opens the Premium screen. Below, the index's counts and size, "Indexing…" while the engine's
// worker has work, and Rebuild. The engine applies every change on its index worker; this page
// only reads `mobile.search.status`, again every few seconds while it is open.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT, getMobileLocale } from './i18n.js';
import { formatSize } from './format.js';

const REFRESH_MS = 3000;

function Toggle({ name, label, hint, checked, badge, onChange }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={`${id}-h`}
      className="mv-setting"
      data-mv-pref={name}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>
          {label}
          {badge && <> <span className="mv-badge">{badge}</span></>}
        </span>
        <span className="mv-setting__hint" id={`${id}-h`}>{hint}</span>
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}

export default function SearchIndexSettings() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const premium = useMobileStore((s) => s.premium?.premium === true);
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const next = await daemonCall('mobile.search.status', {});
      if (mounted.current) {
        setStatus(next);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const set = async (patch) => {
    const ok = await useMobileStore.getState().setPrefs(patch);
    if (mounted.current) setSaveFailed(!ok);
    load();
  };

  const rebuild = async () => {
    try {
      await daemonCall('mobile.search.rebuild', {});
    } catch {
      if (mounted.current) setFailed(true);
    }
    load();
  };

  const count = (n) => new Intl.NumberFormat(getMobileLocale()).format(n || 0);
  const indexing = status?.available && status.state === 'indexing';

  return (
    <>
      <p className="mv-settings__note">{t('mobile.searchIndex.description')}</p>
      <div className="mv-settings__list" data-mv-search-index>
        <Toggle
          name="searchIndexBodies"
          label={t('settings.searchIndex.bodies')}
          hint={t('mobile.searchIndex.bodiesHint')}
          checked={prefs.searchIndexBodies !== false}
          onChange={(v) => set({ searchIndexBodies: v })}
        />
        <Toggle
          name="searchIndexAttachments"
          label={t('settings.searchIndex.attachments')}
          hint={t('mobile.searchIndex.attachmentsHint')}
          checked={premium && prefs.searchIndexAttachments !== false}
          badge={premium ? null : t('common.premium')}
          onChange={(v) => (premium ? set({ searchIndexAttachments: v }) : useMobileStore.getState().openPaywall(null))}
        />
        <div className="mv-setting" data-mv-search-status>
          <span className="mv-setting__text">
            {status && !status.available ? (
              <span className="mv-setting__hint" role="status">{t('mobile.searchIndex.unavailable')}</span>
            ) : status ? (
              <>
                <span className="mv-setting__label">
                  {t('settings.searchIndex.status', { indexed: count(status.indexed), total: count(status.total), size: formatSize(status.sizeBytes || 0) })}
                </span>
                {indexing && <span className="mv-setting__hint" role="status">{t('settings.searchIndex.indexing')}</span>}
              </>
            ) : null}
          </span>
          <button type="button" className="mv-textbtn" data-mv-search-rebuild onClick={rebuild}>
            {t('settings.searchIndex.rebuild')}
          </button>
        </div>
      </div>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.loadFailed')}</p>}
      {saveFailed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
    </>
  );
}
