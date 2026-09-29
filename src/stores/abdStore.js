import { create } from 'zustand';
import { isFinished } from '../utils/abdFrame';

/**
 * Archive & delete jobs (part-d design 6.1). Ephemeral: the daemon owns every
 * job (`<app dir>/abd/<account>/job.json`), so this store only mirrors the
 * last `abd-progress` frame per account and remembers which panel is open.
 * It holds no token, ever: `services/abd.js` hands tokens to the daemon and
 * keeps them out of state, frames and logs.
 *
 * - jobs:     { [accountId]: frame }  the newest frame seen for that account
 * - previews: { [accountId]: { previewId, state, folder, listed, error } }
 *             the setup screen's listing run (`abd-preview` events)
 * - panel:    { accountId, minimized } | null  the one progress panel, in the
 *             main window; closing Settings never touches it
 */
export const useAbdStore = create((set, get) => ({
  jobs: {},
  previews: {},
  panel: null,

  /**
   * A frame from the `abd-progress` event or an `abd.status` reply. Listeners
   * are attached before the status ask, so an old reply can land after a
   * newer live frame: a frame older than the one held for the same job is
   * dropped, and a finished job is never brought back to life.
   */
  applyFrame: (frame) => {
    const accountId = frame?.accountId;
    if (!accountId) return;
    const { jobs, panel } = get();
    const held = jobs[accountId];
    if (held && held.jobId === frame.jobId) {
      if ((frame.updatedMs ?? 0) < (held.updatedMs ?? 0)) return;
      if (isFinished(held) && !isFinished(frame)) return;
    }
    const next = { jobs: { ...jobs, [accountId]: frame } };
    if (!isFinished(frame) && !panel) {
      // A job the person did not just start here: another window started it,
      // or the app was reopened on a running one. Show it small, not in the way.
      next.panel = { accountId, minimized: true };
    } else if (isFinished(frame) && held && !isFinished(held) && panel?.accountId === accountId && panel.minimized) {
      // It ended while tucked away: bring the result back.
      next.panel = { accountId, minimized: false };
    }
    set(next);
  },

  /** The reply to pause/resume/cancel is the job's new status: show it before the next frame. */
  patchStatus: (accountId, status) => {
    const held = get().jobs[accountId];
    if (!held || !status || isFinished(held)) return;
    set({ jobs: { ...get().jobs, [accountId]: { ...held, status } } });
  },

  removeJob: (accountId) => {
    const { jobs, panel } = get();
    if (!(accountId in jobs)) return;
    const { [accountId]: _gone, ...rest } = jobs;
    set({ jobs: rest, panel: panel?.accountId === accountId ? null : panel });
  },

  beginPreview: (accountId, previewId) => set({
    previews: { ...get().previews, [accountId]: { previewId, state: 'listing', folder: null, listed: 0, error: null } },
  }),

  /** An `abd-preview` event. Only the current run of that account counts; an older screen's run is ignored. */
  applyPreview: (event) => {
    const held = get().previews[event?.accountId];
    if (!held || held.previewId !== event.previewId) return;
    set({
      previews: {
        ...get().previews,
        [event.accountId]: {
          ...held,
          state: event.state || held.state,
          folder: event.folder ?? held.folder,
          listed: event.listed ?? held.listed,
          error: event.error ?? null,
        },
      },
    });
  },

  failPreview: (accountId, previewId, error) => {
    const held = get().previews[accountId];
    if (!held || held.previewId !== previewId) return;
    set({ previews: { ...get().previews, [accountId]: { ...held, state: 'failed', error } } });
  },

  clearPreview: (accountId) => {
    const { [accountId]: _gone, ...rest } = get().previews;
    set({ previews: rest });
  },

  openPanel: (accountId) => set({ panel: { accountId, minimized: false } }),
  minimize: () => { const p = get().panel; if (p) set({ panel: { ...p, minimized: true } }); },
  restore: () => { const p = get().panel; if (p) set({ panel: { ...p, minimized: false } }); },
  closePanel: () => set({ panel: null }),
}));

/** The job the panel shows, or null. */
export const selectPanelJob = (s) => (s.panel ? s.jobs[s.panel.accountId] || null : null);
