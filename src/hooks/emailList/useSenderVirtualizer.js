import { useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export function useSenderVirtualizer({ senderFlatItems, scrollContainerRef, isExplorer, emailListGrouping }) {
  const SENDER_ROW_HEIGHT = 56;
  const TOPIC_ROW_HEIGHT = 52;
  const SENDER_EMAIL_ROW_HEIGHT = 44;
  const EMAIL_BODY_HEIGHT = 120;

  // Identity-based key functions — stable keys prevent row shell churn during re-renders
  const getSenderItemKey = useCallback((index) => {
    const item = senderFlatItems[index];
    if (!item) return index;
    switch (item.type) {
      case 'sender': return `s-${item.sender.senderEmail}`;
      case 'topic': return `t-${item.topicKey}`;
      case 'sender-email': return `e-${item.email._accountId || ''}:${item.email.uid}`;
      case 'email-body': return `b-${item.email._accountId || ''}:${item.email.uid}`;
      default: return index;
    }
  }, [senderFlatItems]);

  const senderVirtualizer = useVirtualizer({
    count: senderFlatItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const item = senderFlatItems[index];
      if (!item) return SENDER_ROW_HEIGHT;
      switch (item.type) {
        case 'sender': return SENDER_ROW_HEIGHT;
        case 'topic': return TOPIC_ROW_HEIGHT;
        case 'sender-email': return SENDER_EMAIL_ROW_HEIGHT;
        case 'email-body': return EMAIL_BODY_HEIGHT;
        default: return SENDER_ROW_HEIGHT;
      }
    },
    getItemKey: getSenderItemKey,
    overscan: 5,
    enabled: !isExplorer && emailListGrouping === 'sender',
  });

  return { senderVirtualizer };
}
