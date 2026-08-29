import { Button } from '../ui/Button';
import React, { useState } from 'react';
import { mailboxLabel, decodeImapUtf7 } from '../../utils/imapUtf7';
import {
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { t as tr, useT  } from '../../i18n/index.js';

function CountCell({ count, serverCount }) {
  if (serverCount === 0) return <span className="text-mail-text-muted">--</span>;
  const complete = count >= serverCount;
  return (
    <span className={complete ? 'text-mail-success' : 'text-mail-warning'}>
      {count}
    </span>
  );
}

function FolderRow({ folder, depth = 0, hasExternal, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = folder.children?.length > 0;
  const isContainer = folder.server_count === 0 && hasChildren;

  return (
    <>
      <tr className="text-xs border-b border-mail-border hover:bg-mail-surface-hover/50">
        <td className="py-1 pr-2">
          <div className="flex items-center" style={{ paddingLeft: depth * 16 }}>
            {hasChildren ? (
              <button onClick={() => setExpanded(!expanded)} className="p-0.5 -ml-1 mr-0.5 text-mail-text-muted hover:text-mail-text">
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </button>
            ) : (
              <span className="w-4" />
            )}
            <span className={`truncate ${isContainer ? 'text-mail-text-muted italic' : 'text-mail-text'}`}>
              {mailboxLabel(folder.name) || decodeImapUtf7(folder.path)}
            </span>
          </div>
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {isContainer ? <span className="text-mail-text-muted">--</span> : <span className="text-mail-text">{folder.server_count}</span>}
        </td>
        <td className="py-1 px-2 text-right tabular-nums">
          {isContainer ? <span className="text-mail-text-muted">--</span> : <CountCell count={folder.app_count} serverCount={folder.server_count} />}
        </td>
        {hasExternal && (
          <td className="py-1 px-2 text-right tabular-nums">
            {isContainer ? <span className="text-mail-text-muted">--</span> : <CountCell count={folder.external_count} serverCount={folder.server_count} />}
          </td>
        )}
      </tr>
      {expanded && hasChildren && folder.children.map(child => (
        <FolderRow key={child.path} folder={child} depth={depth + 1} hasExternal={hasExternal} />
      ))}
    </>
  );
}

export default function BackupVerificationTree({ data, onHide }) {
  const t = useT();
  const { total_server, total_app, total_external, external_available, folders } = data;
  const hasExternal = external_available || total_external > 0;
  const appComplete = total_app >= total_server && total_server > 0;
  const extComplete = hasExternal && total_external >= total_server && total_server > 0;
  const appPct = total_server > 0 ? Math.round((total_app / total_server) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-mail-text">{t('settings.backup.verify.backupVerification')}</span>
        <Button variant="ghost" size="xs" className="p-0 text-xs" onClick={onHide}>{t('settings.backup.verify.hide')}</Button>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-1.5">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
          appComplete ? 'bg-mail-local-tint text-mail-local' : 'bg-mail-warning-tint text-mail-warning'
        }`}>
          {appComplete ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
          App: {appPct}%
        </span>
        {hasExternal ? (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            extComplete ? 'bg-mail-local-tint text-mail-local' : 'bg-mail-warning-tint text-mail-warning'
          }`}>
            {extComplete ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
            External: {total_server > 0 ? Math.round((total_external / total_server) * 100) : 0}%
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-mail-surface text-mail-text-muted">
            {t('settings.backup.verify.externalNotConfigured')}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-mail-border overflow-hidden">
        <div
          className={`h-1.5 rounded-full transition-all ${appComplete ? 'bg-mail-success' : 'bg-mail-warning'}`}
          style={{ width: `${Math.min(100, appPct)}%` }}
        />
      </div>

      {/* Folder tree table */}
      {folders.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-mail-border bg-mail-bg">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-mail-surface">
              <tr className="border-b border-mail-border text-mail-text-muted">
                <th className="py-1 pr-2 text-left font-medium">{t('common.folder')}</th>
                <th className="py-1 px-2 text-right font-medium w-14">{t('settings.backup.verify.server')}</th>
                <th className="py-1 px-2 text-right font-medium w-14">{t('settings.backup.verify.app')}</th>
                {hasExternal && <th className="py-1 px-2 text-right font-medium w-14">{t('settings.backup.verify.ext')}</th>}
              </tr>
            </thead>
            <tbody>
              {folders.map(f => (
                <FolderRow key={f.path} folder={f} hasExternal={hasExternal} defaultExpanded={folders.length <= 8} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Totals */}
      <div className="flex items-center justify-between text-xs text-mail-text-muted pt-1">
        <span>Total: {total_app}/{total_server} in app{hasExternal && `, ${total_external}/${total_server} external`}</span>
      </div>
    </div>
  );
}
