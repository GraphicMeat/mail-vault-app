import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { previewConversation } from '../../data/previewMail';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../i18n';

/** The selected Chat topic fills the pane; people/topics are earlier screens. */
export function SampleConversation({ compact = false }) {
  const t = useT();
  useSettingsStore(s => s.timeFormat);
  const messages = previewConversation().slice(0, compact ? 2 : 3);
  return <div className="sample-chat">
    <div className="sample-chat-heading">
      <ArrowLeft size={15} aria-hidden="true" />
      <div><strong>{t('settings.preview.subject')}</strong><span>Nell Okafor · {t('common.messageCount', { count: messages.length })}</span></div>
    </div>
    <div className="sample-chat-messages">
      {messages.map(message => <div key={message.id} className={`sample-chat-message ${message.sent ? 'sample-chat-sent' : ''}`}>
        <p>{message.text}</p><span>{message.time}</span>
      </div>)}
    </div>
  </div>;
}
