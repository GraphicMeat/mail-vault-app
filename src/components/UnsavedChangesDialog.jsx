import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { Z } from './ui/layers';
import { useUnsavedStore } from '../stores/unsavedStore';
import { useT } from '../i18n/index.js';
import { diffText, clipDiff } from '../utils/textDiff';

/// Removed text red and struck through, added text green: the colour is never
/// the only cue, <del> and <ins> say it too.
const MARK = {
  del: 'bg-mail-danger-tint text-mail-danger line-through rounded-sm px-0.5',
  add: 'bg-mail-success-tint text-mail-success rounded-sm px-0.5',
};

function TextChange({ change }) {
  const parts = clipDiff(diffText(change.before, change.after));
  return <>
    <span className="font-medium">{change.label}: </span>
    <span className="break-words" data-testid="unsaved-diff">
      {parts.map((part, i) => {
        if (part.type === 'del') return <del key={i} className={MARK.del}>{part.text}</del>;
        if (part.type === 'add') return <ins key={i} className={`${MARK.add} no-underline`}>{part.text}</ins>;
        return <span key={i} className="text-mail-text-muted">{part.text}</span>;
      })}
    </span>
  </>;
}

/// Asked when a way out of a page would drop unsaved edits: what changed, and
/// save, discard or stay. Portaled and above every dialog, so it shows over
/// Settings, minimized or not.
export function UnsavedChangesDialog() {
  const t = useT();
  const pending = useUnsavedStore(s => s.pending);
  const changes = useUnsavedStore(s => s.guard?.changes) || [];
  const busy = useUnsavedStore(s => s.busy);
  const answer = useUnsavedStore(s => s.answer);
  return <Dialog open={!!pending} portal z={Z.alert} role="alertdialog" onClose={() => answer('keep')} dismissable={!busy}
    title={t('unsaved.title')} description={t('unsaved.body')} closeLabel={t('unsaved.keep')}
    data-testid="unsaved-changes"
    icon={<div className="w-10 h-10 rounded-full flex items-center justify-center bg-mail-accent/10">
      <AlertTriangle size={20} className="text-mail-accent-text" />
    </div>}
    footer={<>
      <Button variant="secondary" size="lg" className="flex-1" data-autofocus disabled={busy}
        data-testid="unsaved-keep" onClick={() => answer('keep')}>{t('unsaved.keep')}</Button>
      <Button variant="danger" size="lg" className="flex-1" disabled={busy}
        data-testid="unsaved-discard" onClick={() => answer('discard')}>{t('common.discard')}</Button>
      <Button variant="primary" size="lg" className="flex-1" loading={busy}
        data-testid="unsaved-save" onClick={() => answer('save')}>{t('unsaved.save')}</Button>
    </>}>
    <ul className="list-disc pl-5 text-sm text-mail-text space-y-1" data-testid="unsaved-list">
      {changes.map(change => typeof change === 'string'
        ? <li key={change}>{change}</li>
        : <li key={change.key}><TextChange change={change} /></li>)}
    </ul>
  </Dialog>;
}
