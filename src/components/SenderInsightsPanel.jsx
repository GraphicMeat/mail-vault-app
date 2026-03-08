import React from 'react';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { useSenderInsights } from '../hooks/useSenderInsights';

function StatRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-xs text-mail-text-muted whitespace-nowrap">{label}</span>
      <span className="text-xs text-mail-text text-right truncate">{value}</span>
    </div>
  );
}

export function SenderInsightsPanel({ senderEmail }) {
  const insights = useSenderInsights(senderEmail);

  if (!insights) return null;

  const { totalReceived, totalSent, total, firstDate, lastDate, frequency, topSubjects, accountsUsed } = insights;

  const formatDate = (d) => {
    try {
      return format(d, 'MMM d, yyyy');
    } catch {
      return '—';
    }
  };

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="overflow-hidden"
    >
      <div className="mx-4 mb-2 px-3 py-2.5 rounded-lg border border-mail-border"
           style={{ backgroundColor: 'color-mix(in srgb, var(--mail-surface) 60%, transparent)' }}>
        <div className="space-y-0.5">
          <StatRow
            label="Emails exchanged"
            value={`${totalReceived} received, ${totalSent} sent (${total})`}
          />
          {firstDate && (
            <StatRow label="First contact" value={formatDate(firstDate)} />
          )}
          {lastDate && (
            <StatRow label="Last contact" value={formatDate(lastDate)} />
          )}
          <StatRow label="Frequency" value={frequency} />
          {topSubjects.length > 0 && (
            <StatRow
              label="Common topics"
              value={topSubjects.join(', ')}
            />
          )}
          {accountsUsed.length >= 2 && (
            <StatRow
              label="Via accounts"
              value={accountsUsed.join(', ')}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}
