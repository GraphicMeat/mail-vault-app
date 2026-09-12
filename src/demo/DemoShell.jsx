import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Info, RotateCcw, X, ChevronLeft, ChevronRight, Play, ExternalLink } from 'lucide-react';
import { demoBackend, resetDemoSession } from './runtime.js';
import { demoSitePath, normalizeDemoLocale } from './locale.js';
import { demoTranslate } from './translations.js';
import { useSettingsStore } from '../stores/settingsStore.js';

const TOUR = [
  { title: 'tour.read.title', body: 'tour.read.body', key: 'default' },
  { title: 'tour.archive.title', body: 'tour.archive.body', key: 'archive' },
  { title: 'tour.compose.title', body: 'tour.compose.body', key: 'send' },
  { title: 'tour.views.title', body: 'tour.views.body', key: 'insights' },
  { title: 'tour.settings.title', body: 'tour.settings.body', key: 'settings' },
];

// Classify by action first, then use the active language's terms. Keeping
// these phrases grouped prevents short words such as French "lu" from
// matching unrelated controls and keeps "Senders" separate from "Send".
const ACTION_TERMS = {
  en: { navigation: ['conversations', 'inbox view', 'list view', 'explorer'], search: ['search', 'senders', 'unread', 'filters', 'filter'], appearance: ['appearance', 'theme', 'palette', 'dark', 'light'], layout: ['layout', 'sidebar', 'density', 'pane'], notification: ['notification', 'sound'], tracker: ['tracker', 'link safety'], cleanup: ['cleanup', 'classification'], backup: ['backup'], timeCapsule: ['time capsule', 'snapshot'], compose: ['compose', 'new message'], insights: ['insights', 'insight'], settings: ['settings', 'preference'], archiveIntent: ['archive'], deleteIntent: ['delete', 'trash'], sendIntent: ['send', 'send now', 'send message'], move: ['move', 'move to'], flags: ['star', 'unstar', 'mark read', 'mark unread'] },
  de: { navigation: ['unterhaltungen', 'posteingangansicht', 'listenansicht', 'explorer'], search: ['suche', 'absender', 'ungelesen', 'filter'], appearance: ['darstellung', 'theme', 'thema', 'palette', 'dunkel', 'hell'], layout: ['layout', 'seitenleiste', 'dichte', 'bereich'], notification: ['benachrichtigung', 'ton'], tracker: ['tracker', 'link-sicherheit'], cleanup: ['bereinigung', 'klassifizierung'], backup: ['sicherung', 'backup'], timeCapsule: ['time capsule', 'snapshot'], compose: ['schreiben', 'verfassen', 'neue nachricht'], insights: ['insights', 'einblick'], settings: ['einstellungen', 'präferenz'], archiveIntent: ['archiv'], deleteIntent: ['löschen', 'papierkorb'], sendIntent: ['senden', 'jetzt senden', 'nachricht senden'], move: ['verschieben'], flags: ['stern', 'als gelesen', 'als ungelesen'] },
  fr: { navigation: ['conversations', 'vue de la boîte', 'vue liste', 'explorer'], search: ['recherche', 'expéditeur', 'non lu', 'filtres', 'filtre'], appearance: ['apparence', 'thème', 'palette', 'sombre', 'clair'], layout: ['mise en page', 'barre latérale', 'densité', 'volet'], notification: ['notification', 'son'], tracker: ['traceur', 'sécurité des liens'], cleanup: ['nettoyage', 'classification'], backup: ['sauvegarde'], timeCapsule: ['time capsule', 'instantané'], compose: ['rédiger', 'nouveau message'], insights: ['insights'], settings: ['réglages', 'préférences'], archiveIntent: ['archiv'], deleteIntent: ['supprimer', 'corbeille'], sendIntent: ['envoyer', 'envoyer maintenant'], move: ['déplacer'], flags: ['étoile', 'marquer comme lu', 'marquer comme non lu'] },
  es: { navigation: ['conversaciones', 'vista de bandeja', 'vista de lista', 'explorer'], search: ['buscar', 'remitentes', 'no leído', 'filtros', 'filtro'], appearance: ['apariencia', 'tema', 'paleta', 'oscuro', 'claro'], layout: ['diseño', 'barra lateral', 'densidad', 'panel'], notification: ['notificación', 'sonido'], tracker: ['rastreador', 'seguridad de enlaces'], cleanup: ['limpieza', 'clasificación'], backup: ['copia de seguridad', 'respaldo'], timeCapsule: ['time capsule', 'instantánea'], compose: ['redactar', 'nuevo mensaje'], insights: ['insights'], settings: ['ajustes', 'configuración', 'preferencia'], archiveIntent: ['archivar'], deleteIntent: ['eliminar', 'papelera'], sendIntent: ['enviar', 'enviar ahora'], move: ['mover'], flags: ['estrella', 'marcar como leído', 'marcar como no leído'] },
  it: { navigation: ['conversazioni', 'vista posta', 'vista elenco', 'explorer'], search: ['cerca', 'mittenti', 'non letto', 'filtri', 'filtro'], appearance: ['aspetto', 'tema', 'tavolozza', 'scuro', 'chiaro'], layout: ['layout', 'barra laterale', 'densità', 'riquadro'], notification: ['notifica', 'suono'], tracker: ['tracker', 'sicurezza link'], cleanup: ['pulizia', 'classificazione'], backup: ['backup'], timeCapsule: ['time capsule', 'snapshot'], compose: ['componi', 'nuovo messaggio'], insights: ['insights'], settings: ['impostazioni', 'preferenza'], archiveIntent: ['archivia'], deleteIntent: ['elimina', 'cestino'], sendIntent: ['invia', 'invia ora'], move: ['sposta'], flags: ['stella', 'segna come letto', 'segna come non letto'] },
  'pt-BR': { navigation: ['conversas', 'vista da caixa', 'vista em lista', 'explorer'], search: ['pesquisa', 'remetentes', 'não lida', 'filtros', 'filtro'], appearance: ['aparência', 'tema', 'paleta', 'escuro', 'claro'], layout: ['layout', 'barra lateral', 'densidade', 'painel'], notification: ['notificação', 'som'], tracker: ['rastreador', 'segurança de links'], cleanup: ['limpeza', 'classificação'], backup: ['backup'], timeCapsule: ['time capsule', 'snapshot'], compose: ['escrever', 'nova mensagem'], insights: ['insights'], settings: ['configurações', 'preferência'], archiveIntent: ['arquivar'], deleteIntent: ['excluir', 'lixeira'], sendIntent: ['enviar', 'enviar agora'], move: ['mover'], flags: ['estrela', 'marcar como lida', 'marcar como não lida'] },
  ja: { navigation: ['会話', '受信トレイ表示', 'リスト表示', 'explorer'], search: ['検索', '送信者', '未読', 'フィルター'], appearance: ['外観', 'テーマ', 'パレット', 'ダーク', 'ライト'], layout: ['レイアウト', 'サイドバー', '密度', 'ペイン'], notification: ['通知', 'サウンド'], tracker: ['トラッカー', 'リンクの安全'], cleanup: ['クリーンアップ', '分類'], backup: ['バックアップ'], timeCapsule: ['time capsule', 'スナップショット'], compose: ['作成', '新規メッセージ'], insights: ['インサイト'], settings: ['設定', '環境設定'], archiveIntent: ['アーカイブ'], deleteIntent: ['削除', 'ゴミ箱'], sendIntent: ['送信', '今すぐ送信'], move: ['移動'], flags: ['スター', '既読にする', '未読にする'] },
  ko: { navigation: ['대화', '받은편지함 보기', '목록 보기', 'explorer'], search: ['검색', '보낸사람', '읽지 않음', '필터'], appearance: ['모양', '테마', '팔레트', '어둡게', '밝게'], layout: ['레이아웃', '사이드바', '밀도', '패널'], notification: ['알림', '소리'], tracker: ['트래커', '링크 안전'], cleanup: ['정리', '분류'], backup: ['백업'], timeCapsule: ['time capsule', '스냅샷'], compose: ['작성', '새 메시지'], insights: ['인사이트'], settings: ['설정', '환경설정'], archiveIntent: ['보관'], deleteIntent: ['삭제', '휴지통'], sendIntent: ['보내기', '지금 보내기'], move: ['이동'], flags: ['별표', '읽음으로 표시', '읽지 않음으로 표시'] },
  'zh-Hans': { navigation: ['会话', '收件箱视图', '列表视图', 'explorer'], search: ['搜索', '发件人', '未读', '筛选'], appearance: ['外观', '主题', '配色', '深色', '浅色'], layout: ['布局', '侧栏', '密度', '窗格'], notification: ['通知', '声音'], tracker: ['跟踪', '链接安全'], cleanup: ['清理', '分类'], backup: ['备份'], timeCapsule: ['time capsule', '快照'], compose: ['撰写', '新邮件'], insights: ['洞察'], settings: ['设置', '偏好'], archiveIntent: ['归档'], deleteIntent: ['删除', '垃圾箱'], sendIntent: ['发送', '立即发送'], move: ['移动'], flags: ['星标', '标记为已读', '标记为未读'] },
};

const hasActionTerm = (label, term) => term.length <= 2 && /^[a-zÀ-ÿ]+$/i.test(term)
  ? new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?=\\s|$|[.,!?])`, 'u').test(label)
  : label.includes(term);

function readDemoStorageStatus() {
  const demo = typeof window !== 'undefined' ? window.__MAILVAULT_DEMO__ : null;
  try {
    const result = demo?.getDemoStorageStatus?.() || demo?.storage?.();
    if (result && typeof result === 'object') {
      if (result.mode === 'memory' && result.status !== 'expired') return 'memory';
      return result.status || 'new';
    }
    return result || demo?.storageStatus || 'new';
  } catch {
    return demo?.storageStatus || 'new';
  }
}

function storageCopyKey(status) {
  if (status === 'expired') return 'storage.expired';
  if (['unavailable', 'quota'].includes(status) || status === 'memory') return 'storage.memory';
  if (status === 'reset') return 'storage.reset';
  return 'storage.durable';
}

function classifyClick(target, locale = 'en') {
  const row = target?.closest?.('[data-testid="email-row"],[data-testid="thread-member-row"],[data-testid="sender-topic-row"],[data-testid="sender-email-row"]');
  const node = target?.closest?.('button,[role="button"],a,input,select,textarea');
  if (!node) return row ? 'viewing' : null;
  if (node.matches?.('[data-testid="mail-search-input"],[data-testid="mail-search-toggle"],[data-testid="search-filters-toggle"],[data-testid="explorer-search"]')) return 'search';
  if (node.matches?.('[data-testid="folder-row"]')) return 'navigation';
  const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.textContent || ''}`.toLowerCase();
  const terms = ACTION_TERMS[locale] || ACTION_TERMS.en;
  const has = category => (terms[category] || []).some(term => hasActionTerm(label, term));
  if (node.closest?.('.sidebar-account-row') || has('navigation')) return 'navigation';
  if (has('search')) return 'search';
  if (has('appearance')) return 'appearance';
  if (has('layout')) return 'layout';
  if (has('notification')) return 'notification';
  if (has('tracker')) return 'tracker';
  if (has('cleanup')) return 'cleanup';
  if (has('backup')) return 'backup';
  if (has('timeCapsule')) return 'timeCapsule';
  if (has('compose')) return 'compose';
  if (has('insights')) return 'insights';
  if (has('settings')) return 'settings';
  if (has('archiveIntent')) return 'archiveIntent';
  if (has('deleteIntent')) return 'deleteIntent';
  if (has('sendIntent')) return 'sendIntent';
  if (has('move')) return 'move';
  if (has('flags')) return 'flags';
  if (row || node.closest?.('[data-testid="chat-view"],[data-testid="chat-sender-list"],[data-testid="insights-reader"]')) return 'viewing';
  return null;
}

// Tour targets can appear after a real view updates its store. Waiting for the
// target keeps the guided action deterministic without coupling this shell to
// the app's loading implementation.
function whenElementReady(find, action, timeoutMs = 2000) {
  const run = () => {
    const element = find();
    if (!element) return false;
    action(element);
    return true;
  };
  if (run() || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver(() => {
    if (run()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), timeoutMs);
}

function selectInitialInbox(afterFolder) {
  const account = [...document.querySelectorAll('button.sidebar-account-open')][0];
  const waitForAccount = () => whenElementReady(
    () => account?.getAttribute('aria-current') === 'true' ? account : null,
    () => whenElementReady(
      () => document.querySelector('[data-testid="folder-row"][data-path="INBOX"]'),
      folder => { folder.click(); afterFolder?.(); },
    ),
  );
  if (!account) { afterFolder?.(); return; }
  if (account.getAttribute('aria-current') !== 'true') account.click();
  waitForAccount();
}

function closeAppSurface(locale = 'en') {
  const closeWords = {
    en: ['close'], de: ['schließen', 'schliessen'], fr: ['fermer'], es: ['cerrar'], it: ['chiudi'],
    'pt-BR': ['fechar'], ja: ['閉じる'], ko: ['닫기'], 'zh-Hans': ['关闭'],
  }[locale] || ['close'];
  const button = [...document.querySelectorAll('.fixed.inset-0 button[aria-label], .fixed.inset-0 button[title]')]
    .find(node => closeWords.some(word => `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.toLowerCase().includes(word)));
  button?.click();
}

export function DemoShell({ children }) {
  const appLanguage = useSettingsStore(s => s.language);
  const locale = normalizeDemoLocale(appLanguage) || 'en';
  const copy = (key) => ({ title: demoTranslate(locale, `copy.${key}.title`), body: demoTranslate(locale, `copy.${key}.body`) });
  const [panelOpen, setPanelOpen] = useState(true);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [explanationKey, setExplanationKey] = useState('default');
  const [customExplanation, setCustomExplanation] = useState(null);
  const [storageStatus, setStorageStatus] = useState(readDemoStorageStatus);
  const lastInteractionRef = useRef(0);
  const tourCloseRef = useRef(null);
  const tourPanelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const tourNavigatingRef = useRef(false);

  useEffect(() => demoBackend.on('demo:state', ({ payload }) => {
    if (payload?.type === 'storage-status' && payload.status) setStorageStatus(payload.mode === 'memory' && payload.status !== 'expired' ? 'memory' : payload.status);
    const key = payload?.type === 'external-link' ? 'externalLink' : payload?.type === 'server-delete' ? 'delete' : payload?.type === 'vault-delete' ? 'localDelete' : payload?.type === 'archive' ? 'archive' : payload?.type === 'draft-saved' ? 'draft' : payload?.type === 'send' ? 'send' : payload?.type === 'flags' ? 'flags' : payload?.type === 'move' ? 'move' : payload?.type === 'import' ? 'import' : payload?.type === 'export' ? 'export' : payload?.type === 'migration' ? 'migration' : payload?.type === 'unsupported-network' && Date.now() - lastInteractionRef.current < 1500 ? 'unsupported' : null;
    if (key) { setExplanationKey(key); setCustomExplanation(null); }
  }), []);

  useEffect(() => {
    const onStorage = event => {
      const status = event?.detail?.status || event?.payload?.status;
      if (status) setStorageStatus((event?.detail?.mode || event?.payload?.mode) === 'memory' && status !== 'expired' ? 'memory' : status);
    };
    window.addEventListener('demo:storage', onStorage);
    const off = demoBackend.on('demo:storage', onStorage);
    const onExpired = () => setStorageStatus('expired');
    window.addEventListener('mailvault-demo-expired', onExpired);
    return () => { window.removeEventListener('demo:storage', onStorage); window.removeEventListener('mailvault-demo-expired', onExpired); off?.(); };
  }, []);

  useEffect(() => {
    const title = demoTranslate(locale, 'meta.title');
    const description = demoTranslate(locale, 'meta.description');
    document.title = title;
    document.documentElement.lang = locale;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.appendChild(meta); }
    meta.content = description;
  }, [locale]);

  const tour = TOUR[tourStep];
  const explanation = customExplanation || copy(explanationKey);
  const tourCopy = useMemo(() => copy(tour.key), [locale, tour.key]);

  useEffect(() => {
    if (!tourOpen) return undefined;
    previousFocusRef.current = document.activeElement;
    tourCloseRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); setTourOpen(false); return; }
      if (event.key !== 'Tab') return;
      const root = tourPanelRef.current;
      const focusable = [...(root?.querySelectorAll('button:not([disabled]),a[href],input,select,textarea') || [])];
      if (!focusable.length) return;
      const index = focusable.indexOf(document.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
      event.preventDefault();
      focusable[next].focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (!tourNavigatingRef.current && previousFocusRef.current?.focus) requestAnimationFrame(() => previousFocusRef.current.focus());
    };
  }, [tourOpen]);

  useEffect(() => {
    document.body.dataset.demoPanel = panelOpen ? 'open' : 'closed';
    return () => { delete document.body.dataset.demoPanel; };
  }, [panelOpen]);

  const reset = async () => {
    await resetDemoSession();
    window.location.reload();
  };

  const handleClick = event => {
    lastInteractionRef.current = Date.now();
    const key = classifyClick(event.target, locale);
    if (key) {
      setExplanationKey(key); setCustomExplanation(null);
    } else {
      const node = event.target?.closest?.('button,a,input,select,textarea,[role="button"],[role="combobox"]');
      if (node) {
        const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
        setCustomExplanation(label ? { title: demoTranslate(locale, 'copy.control.selected', { label }), body: demoTranslate(locale, 'copy.control.body') } : null);
        if (!label) setExplanationKey('control');
      }
    }
  };

  const handleChange = event => {
    const key = classifyClick(event.target, locale) || 'settings';
    setExplanationKey(key); setCustomExplanation(null);
  };

  const openTourSurface = () => {
    tourNavigatingRef.current = true;
    setTourOpen(false);
    requestAnimationFrame(() => {
      if (tourStep === 2) {
        document.querySelector('[data-testid="open-compose"], .sidebar-compose button')?.click();
      } else if (tourStep === 3) {
        document.querySelector('[data-testid="open-insights"]')?.click();
      } else if (tourStep === 4) {
        document.querySelector('[data-testid="open-settings"]')?.click();
      } else if (tourStep === 0) {
        closeAppSurface(locale);
        selectInitialInbox(() => whenElementReady(
          () => document.querySelector('[data-testid="mail-search-toggle"]'),
          toggle => {
            toggle.click();
            whenElementReady(
              () => document.querySelector('[data-testid="mail-search-input"], input[placeholder*="Search" i], input[aria-label*="Search" i]'),
              input => input.focus(),
            );
          },
        ));
      } else if (tourStep === 1) {
        closeAppSurface(locale);
        selectInitialInbox(() => whenElementReady(
          () => [...document.querySelectorAll('[data-testid="email-row"]')]
            .find(node => node.textContent?.includes('Your weekly workspace digest')),
          row => row.click(),
        ));
      }
    });
  };

  return (
    <div className="demo-shell" onClickCapture={handleClick} onChangeCapture={handleChange} data-testid="demo-shell">
      <header className="demo-header">
        <div className="demo-brand">
          <span className="demo-kicker">{demoTranslate(locale, 'brand.kicker')}</span>
          <span className="demo-title">{demoTranslate(locale, 'brand.title')}</span>
          <span className="demo-pill">{demoTranslate(locale, 'brand.pill')}</span>
        </div>
        <nav className="demo-actions" aria-label={demoTranslate(locale, 'actions.aria')}>
          <a href={demoSitePath('/', locale)} className="demo-link"><ExternalLink size={14} /> {demoTranslate(locale, 'actions.site')}</a>
          <a href={demoSitePath('/get-started.html?plan=free', locale)} className="demo-link"><ExternalLink size={14} /> {demoTranslate(locale, 'actions.download')}</a>
          <button type="button" data-testid="demo-tour" className="demo-button demo-tour-button" onClick={() => { tourNavigatingRef.current = false; setTourStep(0); setTourOpen(true); }}><Play size={14} /> {demoTranslate(locale, 'actions.tour')}</button>
          <button type="button" data-testid="demo-reset" className="demo-button" onClick={reset}><RotateCcw size={14} /> {demoTranslate(locale, 'actions.reset')}</button>
          <button type="button" className="demo-icon-button" aria-label={demoTranslate(locale, panelOpen ? 'actions.hideExplanation' : 'actions.showExplanation')} onClick={() => setPanelOpen(open => !open)}><Info size={16} /></button>
        </nav>
      </header>
      <div className={`demo-body ${panelOpen ? 'demo-panel-open' : ''}`}>
        <div className="demo-app-wrap">{children}</div>
        {panelOpen && (
          <aside className="demo-explanation" aria-label={demoTranslate(locale, 'explanation.aria')} data-testid="demo-explanation">
            <div className="demo-explanation-heading"><Info size={16} /><span>{demoTranslate(locale, 'explanation.heading')}</span><button type="button" className="demo-close" aria-label={demoTranslate(locale, 'explanation.hide')} onClick={() => setPanelOpen(false)}><X size={15} /></button></div>
            <h2>{explanation.title}</h2>
            <p>{explanation.body}</p>
            <p className="demo-simulation-note" role="status" data-testid="demo-storage-status">{demoTranslate(locale, storageCopyKey(storageStatus))}</p>
          </aside>
        )}
      </div>
      {tourOpen && (
        <div className="demo-tour-backdrop" role="presentation">
          <section ref={tourPanelRef} className="demo-tour" role="dialog" aria-modal="true" aria-labelledby="demo-tour-title">
            <button ref={tourCloseRef} type="button" className="demo-close demo-tour-close" aria-label={demoTranslate(locale, 'tour.exit')} onClick={() => setTourOpen(false)}><X size={17} /></button>
            <span className="demo-kicker">{demoTranslate(locale, 'tour.kicker', { step: tourStep + 1, total: TOUR.length })}</span>
            <h2 id="demo-tour-title">{demoTranslate(locale, tour.title)}</h2>
            <p>{demoTranslate(locale, tour.body)}</p>
            <div className="demo-tour-preview"><Info size={15} /><span>{tourCopy.body}</span></div>
            <button type="button" data-testid="demo-tour-open" className="demo-button demo-tour-open" onClick={openTourSurface}>{demoTranslate(locale, 'tour.open')} <ExternalLink size={14} /></button>
            <div className="demo-tour-controls">
              <button type="button" className="demo-button" disabled={tourStep === 0} onClick={() => setTourStep(step => step - 1)}><ChevronLeft size={15} /> {demoTranslate(locale, 'tour.back')}</button>
              {tourStep < TOUR.length - 1 ? <button type="button" className="demo-button demo-button-primary" onClick={() => setTourStep(step => step + 1)}>{demoTranslate(locale, 'tour.next')} <ChevronRight size={15} /></button> : <button type="button" className="demo-button demo-button-primary" onClick={() => setTourOpen(false)}>{demoTranslate(locale, 'tour.explore')} <ChevronRight size={15} /></button>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
