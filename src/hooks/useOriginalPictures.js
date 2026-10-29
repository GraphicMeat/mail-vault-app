import { useEffect, useMemo, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { hydrateInlineImages, replaceCidUrls } from '../services/attachmentUtils';

// The daemon builds a reply's original HTML from the body alone, so a picture
// the body shows by cid: has no bytes in it. This gives the frame what the
// reading pane gives its own: the cid: references of `html` resolved against
// the original messages' attachments, read back from the cached .eml when the
// light fetch that loaded them carried none. `messages` must be a stable array.
export function useOriginalPictures(html, messages) {
  const [attachments, setAttachments] = useState([]);
  useEffect(() => {
    const withPictures = messages.filter(message => message?.attachments?.length);
    if (!withPictures.length) return undefined;
    let live = true;
    (async () => {
      const state = useMailStore.getState();
      const hydrated = await Promise.all(withPictures.map(async (message) => {
        const loc = resolveEmailLocation(message, state);
        return loc && message.uid != null ? hydrateInlineImages(message, loc.accountId, loc.mailbox) : message;
      }));
      if (live) setAttachments(hydrated.flatMap(message => message.attachments || []));
    })();
    return () => { live = false; };
  }, [messages]);
  return useMemo(() => replaceCidUrls(html, attachments), [html, attachments]);
}
