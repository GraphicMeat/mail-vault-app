import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';

// Like the tag render cache: the durable key lives in the daemon
// (`app_db::identity::msg_key`) and is deliberately not mirrored here. This is
// only what the rows on screen are showing, refetched per page.
export function fieldRowKey(accountId, mailbox, uid) {
  return `${accountId}|${mailbox}|${uid}`;
}

function rowKeyOf(email, location) {
  if (!email || email.uid == null) return null;
  if (!location?.accountId || !location?.mailbox || location.mailbox === 'UNIFIED') return null;
  return fieldRowKey(location.accountId, location.mailbox, email.uid);
}

function itemOf(email, location) {
  const item = { accountId: location.accountId, mailbox: location.mailbox, uid: email.uid };
  if (email.messageId) item.messageId = email.messageId;
  return item;
}

const EMPTY = {};

export const useFieldStore = create((set, get) => ({
  /// account id → its schema (the global fields first, then its own).
  fields: {},
  /// rowKey → { fieldId: value } for the rows currently rendered.
  byRow: {},

  fieldsFor: (accountId) => get().fields[accountId] || [],
  valuesFor: (email, location) => {
    const key = rowKeyOf(email, location);
    return (key && get().byRow[key]) || EMPTY;
  },

  loadFields: async (accountId) => {
    if (!accountId) return [];
    const fields = await daemonCall('fields.list', { accountId });
    set(state => ({ fields: { ...state.fields, [accountId]: Array.isArray(fields) ? fields : [] } }));
    return get().fieldsFor(accountId);
  },

  saveField: async (accountId, field) => {
    const saved = await daemonCall('fields.save', { field });
    await get().loadFields(accountId);
    return saved;
  },

  deleteField: async (accountId, fieldId) => {
    await daemonCall('fields.delete', { id: fieldId });
    set(state => ({
      byRow: Object.fromEntries(Object.entries(state.byRow).map(([key, values]) => {
        const { [fieldId]: _gone, ...rest } = values;
        return [key, rest];
      })),
    }));
    await get().loadFields(accountId);
  },

  /// How many messages hold each choice of a field. Asked before a choice is
  /// removed: removing one leaves it on every message that already holds it,
  /// where it renders as nothing.
  optionUsage: async (fieldId) => {
    try {
      const usage = await daemonCall('fields.option_usage', { fieldId });
      return usage && typeof usage === 'object' ? usage : {};
    } catch {
      return {};
    }
  },

  /// Copy a schema, or part of one, into another account. The fields travel;
  /// the answers stay where they were given.
  copyFields: async (fieldIds, accountId) => {
    const copied = await daemonCall('fields.copy', { fieldIds, accountId });
    await get().loadFields(accountId);
    return copied;
  },

  /// Fill the render cache for one page of rows. The daemon answers one entry
  /// per requested row, in request order.
  loadRowValues: async (rows) => {
    const resolved = rows
      .map(({ email, location }) => ({ key: rowKeyOf(email, location), email, location }))
      .filter(row => row.key);
    if (!resolved.length) return;
    const reply = await daemonCall('fields.values', { items: resolved.map(row => itemOf(row.email, row.location)) });
    const lists = Array.isArray(reply?.values) ? reply.values : [];
    set(state => {
      const byRow = { ...state.byRow };
      resolved.forEach((row, index) => {
        const values = lists[index] || {};
        if (Object.keys(values).length) byRow[row.key] = values;
        else delete byRow[row.key];
      });
      return { byRow };
    });
  },

  /// Set or clear one value. The reader shows it at once and puts the old one
  /// back if the daemon refuses.
  setValue: async (email, location, fieldId, value) => {
    const key = rowKeyOf(email, location);
    if (!key) return false;
    const before = get().byRow;
    set(state => {
      const current = { ...(state.byRow[key] || {}) };
      if (value === null || value === undefined || value === '') delete current[fieldId];
      else current[fieldId] = value;
      const byRow = { ...state.byRow };
      if (Object.keys(current).length) byRow[key] = current;
      else delete byRow[key];
      return { byRow };
    });
    try {
      await daemonCall('fields.set', {
        item: itemOf(email, location),
        fieldId,
        value: value === '' ? null : value ?? null,
      });
      return true;
    } catch {
      set({ byRow: before });
      return false;
    }
  },
}));

// One request per row would be one daemon call per property strip. Collect what
// this tick asked for and make one call, the way the tag chips do.
let pendingRows = new Map();
let pendingTimer = null;

async function flushRowValues() {
  pendingTimer = null;
  const rows = [...pendingRows.values()];
  pendingRows = new Map();
  if (!rows.length) return;
  try {
    await useFieldStore.getState().loadRowValues(rows);
  } catch {
    // A row whose values could not load renders without them.
  }
}

// A schema is asked for once per account. The strip renders on every message,
// so an unguarded call would retry a failing load on every render — and an
// uncaught one would surface as an unhandled rejection rather than an absent
// strip.
const askedSchemas = new Set();

/// Ask for an account's schema, unless it is loaded or already on its way.
export function requestSchema(accountId) {
  if (!accountId || askedSchemas.has(accountId) || useFieldStore.getState().fields[accountId]) return;
  askedSchemas.add(accountId);
  useFieldStore
    .getState()
    .loadFields(accountId)
    .catch(error => {
      askedSchemas.delete(accountId);
      console.warn('[fields] could not load a schema:', error?.message || error);
    });
}

/// Ask for a row's values, unless the render cache already holds them.
export function requestRowValues(email, location) {
  const key = rowKeyOf(email, location);
  if (!key || useFieldStore.getState().byRow[key] || pendingRows.has(key)) return;
  pendingRows.set(key, { email, location });
  if (!pendingTimer) pendingTimer = setTimeout(flushRowValues, 0);
}
