import { t } from '../i18n/index.js';

export const composeSnapshotForTransfer = snapshot => snapshot ? JSON.parse(JSON.stringify(snapshot)) : snapshot;
export const isComposeMessage = (message, composeId, token) => Boolean(
  message && String(message.composeId) === String(composeId)
    && (!token || message.token === token) && typeof message.type === 'string'
);

const makeToken = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function createComposeWindowOwner({ open, emitTo, update, close, remove, queueSend, settings }) {
  const sessions = new Map();
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
        session.snapshot = composeSnapshotForTransfer(message.payload);
        update(session.id, { snapshot: session.snapshot });
        void reply(session, requestId, 'ack').catch(() => recover(session));
      } else if (message.type === 'discard') {
        if (session.busy) {
          void reply(session, requestId, 'error', t('errors.composeWindowRequestInProgress')).catch(() => recover(session));
          return true;
        }
        session.terminal = true;
        void reply(session, requestId, 'ack').then(() => {
          remove?.(session.id);
          finish(session);
        }).catch(() => { session.terminal = false; recover(session); });
      } else if (message.type === 'return' || message.type === 'closed' || message.type === 'minimize') {
        if (session.busy) {
          void reply(session, requestId, 'error', t('errors.composeWindowRequestInProgress')).catch(() => recover(session));
          return true;
        }
        const latest = composeSnapshotForTransfer(message.payload || session.snapshot);
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
          update(session.id, { snapshot: latest, initialData: latest, minimized: true, detached: false, nativeLabel: null });
          finish(session, new Error(t('errors.composeWindowClosed')));
        }).catch(() => { session.terminal = false; recover(session); });
      } else if (message.type === 'send' || message.type === 'schedule') {
        if (session.busy || session.terminal) {
          void reply(session, requestId, 'error', t('errors.composeWindowRequestInProgress')).catch(() => recover(session));
          return true;
        }
        session.busy = message.type;
        const payload = message.payload || {};
        let queued = false;
        void Promise.resolve()
          .then(() => queueSend(composeSnapshotForTransfer(payload.snapshot || session.snapshot), payload.delay, session, message.type === 'schedule'))
          .then(() => {
            queued = true;
            if (session.destroyed) {
              remove?.(session.id);
              finish(session);
              return;
            }
            session.terminal = true;
            return reply(session, requestId, message.type === 'send' ? 'accepted' : 'scheduled');
          })
          .then(() => {
            remove?.(session.id);
            finish(session);
          })
          .catch(error => {
            if (queued) {
              // Main already owns this mail. A lost acknowledgement must
              // close the child rather than invite a duplicate retry.
              close(session.label);
              remove?.(session.id);
              finish(session);
              return;
            }
            session.busy = null;
            session.terminal = false;
            if (session.destroyed) {
              recover(session);
              return;
            }
            void reply(session, requestId, 'error', error?.message || String(error)).catch(() => recover(session));
          });
      } else if (message.type === 'settings') {
        const key = message.payload?.key;
        if (!settings?.[key]) {
          void reply(session, requestId, 'error', t('errors.composeWindowSettingUnavailable')).catch(() => recover(session));
          return true;
        }
        void Promise.resolve()
          .then(() => settings[key](message.payload.value))
          .then(payload => reply(session, requestId, 'ack', payload))
          .catch(error => reply(session, requestId, 'error', error?.message || String(error)).catch(() => recover(session)));
      }
      return true;
    },

    recover(id) { return recover(sessionFor(id)); },
    recoverLabel(label, token) {
      const session = [...sessions.values()].find(item => item.label === label && (!token || item.token === token));
      return recover(session);
    },
  };
}
