// Inline `cid:` images in the viewer. The frame loads nothing but inline styles and `data:` images
// (mailFrame.js CSP), and attachment bytes never cross the bridge as a file, so the engine hands
// over a message's inline images as `data:` URLs (`mobile.message.inlineImages`) from the files on
// the phone (the offline download's, else the cache), and the html's `cid:` references are
// rewritten to them before the frame is built. An image not on the phone yet is fetched like a
// tapped attachment (`mobile.attachment.fetch`), and the images are asked for again once it is in.
// Remote images stay opt-in: nothing here touches an https URL.
import { useEffect, useMemo, useState } from 'react';
import { daemonCall } from './transport.js';
import { bareContentId, htmlReferencesCid, replaceCidRefs } from '../utils/cidRefs.js';
import { ensureAttachmentEvents, watchJob } from './attachmentJobs.js';

/** The parts the html shows by `cid:`. */
export function referencedParts(html, attachments) {
  if (!html || !Array.isArray(attachments)) return [];
  return attachments.filter((a) => a?.contentId && htmlReferencesCid(html, a.contentId));
}

/** `html` with each `cid:` reference found in `images` (bare Content-ID -> data URL) replaced. */
export function withInlineImages(html, images) {
  if (!html || !images || Object.keys(images).length === 0) return html;
  return replaceCidRefs(html, (ref) => images[bareContentId(ref)] ?? null);
}

/**
 * The message's inline images as `{contentId: dataUrl}` (null while none are known). Asks the
 * engine only when the html references a part by `cid:`; fetches the ones it lacks, once each.
 */
export function useInlineImages({ accountId, folder, uid, html, attachments }) {
  const wanted = useMemo(() => referencedParts(html, attachments).length > 0, [html, attachments]);
  const [images, setImages] = useState(null);
  useEffect(() => {
    setImages(null);
    if (!wanted) return undefined;
    let live = true;
    const stops = [];
    const fetching = new Set();
    const ask = async () => {
      let got;
      try {
        got = await daemonCall('mobile.message.inlineImages', { accountId, folder, uid });
      } catch {
        return;
      }
      if (!live) return;
      setImages(got?.images && Object.keys(got.images).length ? got.images : null);
      for (const section of got?.missing || []) {
        if (fetching.has(section)) continue;
        fetching.add(section);
        ensureAttachmentEvents();
        daemonCall('mobile.attachment.fetch', { accountId, folder, uid, section }).then(
          ({ jobId }) => {
            if (!live) return;
            stops.push(watchJob(jobId, (kind) => { if (kind === 'done' && live) ask(); }));
          },
          () => {},
        );
      }
    };
    ask();
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [wanted, accountId, folder, uid]);
  return images;
}
