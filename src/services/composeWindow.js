import { mergeComposeSnapshot } from './composeSession';
import { t } from '../i18n/index.js';

export const composeSnapshotForTransfer = snapshot => snapshot ? JSON.parse(JSON.stringify(snapshot)) : snapshot;
export const isComposeMessage = (message, composeId, token) => Boolean(
  message && String(message.composeId) === String(composeId)
    && (!token || message.token === token) && typeof message.type === 'string'
);

const makeToken = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function createComposeWindowOwner({ open, emitTo, update, close, remove, queueSend, discard, settings, attached, acknowledgePreparation, checkPreparation, sendContext }) {
  const sessions = new Map();
  let settingsChain = Promise.resolve();
  let authorityGeneration = 0;
  const unavailable = () => new Error('compose.preparationUnavailable');
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const current = (session, record) => sessionFor(session.id) === session && !session.finished && !session.terminal && !session.destroyed
    && session.checked === record && record.authorityGeneration === authorityGeneration && record.editorGeneration === session.editorGeneration;
  const requireCurrent = (session, record) => { if (!current(session, record)) throw unavailable(); };
  const envelope = record => ({ attempt: record.attempt, editorGeneration: record.editorGeneration, outcome: record.result });
  const setResult = (record, result) => {
    record.result = result;
    record.phase = result.kind === 'ready' ? 'ready' : result.kind === 'confirm_attachment' ? 'confirm' : 'retired';
  };
  const sameContext = (session, record) => {
    const value = sendContext?.(record.snapshot, session);
    if (!value || !value.account || value.account !== record.accountSource || value.senderSettings?.displayName !== record.senderSettings?.displayName) throw unavailable();
  };
  const check = (session, record) => checkPreparation({ snapshot: record.snapshot, mode: session.mode,
    authoredBodyText: record.authoredBodyText, timeZone: record.timeZone, sendAnyway: record.sendAnyway,
    settingsVersion: record.settingsVersion, isCurrent: () => current(session, record) });
  const sessionFor = id => sessions.get(String(id));
  const reply = (session, requestId, type, payload) => {
    if (!session.label) return Promise.reject(new Error(t('errors.composeWindowClosed')));
    return Promise.resolve(emitTo(session.label, 'compose-window-message', {
      composeId: String(session.id), token: session.token, requestId, type, payload,
    }));
  };
  const finish = (session, error) => {
    if (session.finished) return;
    session.finished = true;
    session.checked = null;
    clearTimeout(session.timeout);
    if (sessionFor(session.id) === session) sessions.delete(String(session.id));
    if (error) session.reject?.(error);
  };
  const recover = session => {
    if (!session || session.finished) return false;
    // A send/schedule has already crossed to main. Wait for its result before
    // restoring the source, otherwise a native close can create two editors
    // for one queued message.
    if (session.busy) {
      session.destroyed = true;
      if (session.checked?.phase !== 'consumed') session.checked = null;
      return true;
    }
    if (session.initialized) {
      update(session.id, {
        snapshot: session.snapshot,
        initialData: session.snapshot,
        minimized: true,
        detached: false,
        nativeLabel: null,
      });
    }
    finish(session, new Error(t('errors.composeWindowClosed')));
    return true;
  };
  const initialize = session => {
    if (session.ready && session.label && !session.finished) {
      return reply(session, session.ready, 'initialize', {
        mode: session.mode,
        snapshot: session.snapshot,
        ...session.context,
      });
    }
    return Promise.resolve();
  };

  return {
    detach({ id, mode, snapshot, context }) {
      const session = {
        id,
        mode,
        snapshot: composeSnapshotForTransfer(snapshot),
        context,
        token: makeToken(),
        label: null,
        ready: null,
        initialized: false,
        busy: null,
        finished: false,
        checked: null, lastAttempt: 0, editorGeneration: 0,
      };
      sessions.set(String(id), session);
      const handoff = new Promise((resolve, reject) => {
        session.resolve = resolve;
        session.reject = reject;
      });
      session.timeout = setTimeout(() => {
        if (sessionFor(id) !== session || session.finished) return;
        close(session.label);
        finish(session, new Error(t('errors.composeWindowNotInitialized')));
      }, 10_000);

      Promise.resolve(open({ composeId: String(id), token: session.token })).then(label => {
        if (session.finished || sessionFor(id) !== session) {
          close(label);
          return;
        }
        session.label = label;
        return initialize(session).catch(() => recover(session));
      }).catch(error => finish(session, error));
      return handoff;
    },

    receive(message) {
      const session = sessionFor(message?.composeId);
      if (!session || session.finished || !isComposeMessage(message, session.id, session.token)) return false;
      const requestId = message.requestId;

      if (message.type === 'ready') {
        session.ready = requestId;
        void initialize(session).catch(() => recover(session));
      } else if (message.type === 'initialized') {
        if (!session.ready || session.initialized || !session.label) return true;
        session.initialized = true;
        clearTimeout(session.timeout);
        update(session.id, { detached: true, nativeLabel: session.label, snapshot: session.snapshot, minimized: false });
        void reply(session, requestId, 'activate').then(() => session.resolve?.(session.label)).catch(() => recover(session));
      } else if (message.type === 'snapshot') {
        // Save receipts change bookkeeping, not the checked mail. UI edits also
        // send the immediate generation invalidation, before this debounced path.
        const fields = ['to', 'cc', 'bcc', 'subject', 'body', 'attachments', 'inReplyTo', 'references', '_quotedHtml', '_contextHtml', '_accountId', '_fromAddress', '_sendPlan', '_scheduleDraft', '_remindDays', '_replyTo'];
        if (session.checked && fields.some(key => JSON.stringify(message.payload?.[key]) !== JSON.stringify(session.checked.snapshot[key]))) session.checked = null;
        session.snapshot = mergeComposeSnapshot(session.snapshot, composeSnapshotForTransfer(message.payload));
        update(session.id, { snapshot: session.snapshot });
        void reply(session, requestId, 'ack').catch(() => recover(session));
      } else if (message.type === 'discard') {
        if (session.busy) {
          void reply(session, requestId, 'error', t('errors.composeWindowRequestInProgress')).catch(() => recover(session));
          return true;
        }
        session.checked = null;
        session.terminal = true;
        session.busy = 'discard';
        const latest = mergeComposeSnapshot(session.snapshot, composeSnapshotForTransfer(message.payload || session.snapshot));
        session.snapshot = { ...latest, _draftCleanupOnly: true, _draftTerminal: 'discard', _draftCleanupState: 'unknown' };
        void Promise.resolve().then(() => discard(latest, session.id)).catch(() => {
          // Main's normal owner returns unknown without throwing. If an owner
          // boundary itself fails, retain only terminal recovery, never editor.
          update(session.id, { snapshot: session.snapshot, initialData: session.snapshot, minimized: true, detached: false, nativeLabel: null });
          return { draftId: latest._draftId, discarded: false, cleanup: 'unknown' };
        }).then(async result => {
          session.snapshot = { ...session.snapshot, _draftCleanupState: result.cleanup };
          if (!session.destroyed) {
            try { await reply(session, requestId, 'ack', result); }
            catch { close(session.label); }
          } else close(session.label);
          // App removes only the source, retaining its cleanup-only owner.
          remove?.(session.id);
          finish(session);
        });
      } else if (['return', 'closed', 'minimize', 'attach'].includes(message.type)) {
        // `attach` is the window's "move back into the main window": the same
        // handover, except the draft reopens in main instead of as a bubble.
        const attach = message.type === 'attach';
        if (session.busy) {
          void reply(session, requestId, 'error', t('errors.composeWindowRequestInProgress')).catch(() => recover(session));
          return true;
        }
        session.checked = null;
        const latest = mergeComposeSnapshot(session.snapshot, composeSnapshotForTransfer(message.payload || session.snapshot));
        session.snapshot = latest;
        if (!session.initialized) {
          session.terminal = true;
          void reply(session, requestId, 'ack').catch(() => {}).finally(() => {
            finish(session, new Error(t('errors.composeWindowClosed')));
          });
          return true;
        }
        session.terminal = true;
        void reply(session, requestId, 'ack').then(() => {
          // Before the update that mounts main's compose: that mount decides
          // whether to hand the draft straight back to a window.
          if (attach) attached?.(session.id);
          update(session.id, { snapshot: latest, initialData: latest, minimized: !attach, detached: false, nativeLabel: null });
          finish(session, new Error(t('errors.composeWindowClosed')));
        }).catch(() => { session.terminal = false; recover(session); });
      } else if (message.type === 'send' || message.type === 'schedule') {
        const payload = message.payload || {};
        const record = session.checked;
        if (session.busy || session.terminal || !record || record.phase !== 'ready' || !current(session, record)
          || Object.keys(payload).some(key => !['attempt', 'editorGeneration'].includes(key))
          || payload.attempt !== record.attempt || payload.editorGeneration !== record.editorGeneration) {
          void reply(session, requestId, 'error', 'compose.preparationUnavailable').catch(() => recover(session));
          return true;
        }
        record.phase = 'admitting';
        session.busy = message.type;
        let queued = false;
        void Promise.resolve().then(async () => {
          requireCurrent(session, record);
          const result = await check(session, record);
          requireCurrent(session, record);
          setResult(record, result);
          if (result.kind !== 'ready') {
            session.busy = null;
            await reply(session, requestId, 'ack', envelope(record));
            return;
          }
          if (!!result.route.draft !== (message.type === 'schedule')) throw unavailable();
          sameContext(session, record);
          const handoff = composeSnapshotForTransfer(record.snapshot);
          handoff._composeDelay = result.route.delay;
          if (result.route.draft) handoff._scheduleDraft = composeSnapshotForTransfer(result.route.draft);
          if (!record.remindAllowed) handoff._remindDays = 0;
          record.phase = 'consumed';
          // Consuming authority and entering the existing owner are synchronous.
          await queueSend(handoff, result.route.delay, session, !!result.route.draft, { account: record.account, settings: record.senderSettings });
          queued = true;
          session.terminal = true;
          if (!session.destroyed) await reply(session, requestId, message.type === 'send' ? 'accepted' : 'scheduled');
          remove?.(session.id);
          finish(session);
        }).catch(error => {
          if (queued) {
            close(session.label); remove?.(session.id); finish(session); return;
          }
          if (record.phase !== 'consumed') record.phase = 'retired';
          session.busy = null;
          if (session.destroyed) { recover(session); return; }
          void reply(session, requestId, 'error', error?.message || 'compose.preparationUnavailable').catch(() => recover(session));
        });
      } else if (message.type === 'prepare-settings') {
        const payload = message.payload;
        if (payload?.purpose === 'invalidate-send-check') {
          if (Number.isSafeInteger(payload.editorGeneration) && payload.editorGeneration > session.editorGeneration) {
            session.editorGeneration = payload.editorGeneration;
            if (session.checked?.phase !== 'consumed') session.checked = null;
          }
          void reply(session, requestId, 'ack').catch(() => recover(session));
          return true;
        }
        if (payload?.purpose === 'send-check') {
          const previous = session.checked;
          const confirmation = payload.confirmationAttempt != null;
          const allowed = confirmation ? ['purpose', 'attempt', 'editorGeneration', 'confirmationAttempt'] : ['purpose', 'attempt', 'editorGeneration', 'snapshot', 'authoredBodyText', 'timeZone'];
          if (session.busy || session.terminal || !checkPreparation || !positive(payload.attempt) || payload.attempt <= session.lastAttempt
            || !Number.isSafeInteger(payload.editorGeneration) || payload.editorGeneration < session.editorGeneration
            || Object.keys(payload).some(key => !allowed.includes(key))
            || confirmation && (!previous || previous.phase !== 'confirm' || previous.attempt !== payload.confirmationAttempt || previous.editorGeneration !== payload.editorGeneration || !current(session, previous))
            || !confirmation && (!payload.snapshot || typeof payload.authoredBodyText !== 'string' || typeof payload.timeZone !== 'string')) {
            void reply(session, requestId, 'error', 'compose.preparationUnavailable').catch(() => recover(session));
            return true;
          }
          session.lastAttempt = payload.attempt;
          session.editorGeneration = payload.editorGeneration;
          const record = { attempt: payload.attempt, editorGeneration: payload.editorGeneration, phase: 'checking',
            snapshot: composeSnapshotForTransfer(confirmation ? previous.snapshot : payload.snapshot),
            authoredBodyText: confirmation ? previous.authoredBodyText : payload.authoredBodyText,
            timeZone: confirmation ? previous.timeZone : payload.timeZone, sendAnyway: confirmation,
            authorityGeneration };
          session.checked = record;
          // Recovery gets the issued complete source immediately, before any IO.
          session.snapshot = mergeComposeSnapshot(session.snapshot, composeSnapshotForTransfer(record.snapshot));
          update(session.id, { snapshot: session.snapshot });
          const context = sendContext?.(record.snapshot, session);
          record.accountSource = context?.account;
          record.account = composeSnapshotForTransfer(context?.account);
          record.senderSettings = composeSnapshotForTransfer(context?.senderSettings);
          record.remindAllowed = !!context?.remindAllowed;
          void settingsChain.then(async () => {
            for (let retry = 0; retry < 2; retry++) {
              requireCurrent(session, record);
              record.settingsVersion = await acknowledgePreparation({ purpose: 'send-check' });
              requireCurrent(session, record);
              try {
                const result = await check(session, record);
                requireCurrent(session, record);
                setResult(record, result);
                await reply(session, requestId, 'ack', envelope(record));
                return;
              } catch (error) {
                if (retry === 0 && error?.message === 'errors.settingsConflict' && current(session, record)) continue;
                throw error;
              }
            }
          }).catch(() => {
            if (session.checked === record) session.checked = null;
            if (!session.finished) void reply(session, requestId, 'error', 'compose.preparationUnavailable').catch(() => recover(session));
          });
          return true;
        }
        const run = settingsChain.then(() => {
          if (session.finished || sessionFor(session.id) !== session) throw new Error('errors.composeWindowClosed');
          if (payload != null || !acknowledgePreparation) throw unavailable();
          return acknowledgePreparation();
        });
        void run.then(version => {
          if (!session.finished && sessionFor(session.id) === session) return reply(session, requestId, 'ack', version);
        }).catch(() => {
          if (!session.finished && sessionFor(session.id) === session) return reply(session, requestId, 'error', 'compose.preparationUnavailable').catch(() => recover(session));
        });
      } else if (message.type === 'settings') {
        const key = message.payload?.key;
        if (!settings?.[key]) {
          void reply(session, requestId, 'error', t('errors.composeWindowSettingUnavailable')).catch(() => recover(session));
          return true;
        }
        const run = settingsChain.then(() => settings[key](message.payload.value));
        settingsChain = run.catch(() => {});
        void run.then(payload => reply(session, requestId, 'ack', payload))
          .catch(error => reply(session, requestId, 'error', error?.message || String(error)).catch(() => recover(session)));
      }
      return true;
    },

    // A window is handed main's settings once, in its context at detach. A
    // change made in main since (an upgrade above all, or its Premium panels
    // stay locked) is pushed to every window, and folded into the context
    // of one still starting up.
    invalidateSendPreparation() {
      authorityGeneration++;
      for (const session of sessions.values()) if (session.checked?.phase !== 'consumed') session.checked = null;
    },
    pushSettings(patch) {
      for (const session of sessions.values()) {
        if (session.finished) continue;
        session.context = { ...session.context, settings: { ...session.context?.settings, ...patch } };
        if (session.label) void reply(session, null, 'settings-changed', patch).catch(() => {});
      }
    },

    pushAccounts(accounts, activeAccountId) {
      for (const session of sessions.values()) {
        if (session.finished) continue;
        session.context = { ...session.context, accounts, activeAccountId };
        if (session.label) void reply(session, null, 'accounts-changed', { accounts, activeAccountId }).catch(() => {});
      }
    },
    recover(id) { return recover(sessionFor(id)); },
    recoverLabel(label, token) {
      const session = [...sessions.values()].find(item => item.label === label && (!token || item.token === token));
      return recover(session);
    },
  };
}
