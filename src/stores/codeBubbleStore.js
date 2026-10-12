import { create } from 'zustand';

// The corner bubbles for one-time codes that arrived by mail. Not persisted: a
// code is good for minutes, and a bubble leaves on its own when it is stale.
export const CODE_BUBBLE_TTL_MS = 10 * 60 * 1000;
const MAX_BUBBLES = 3;

const timers = new Map();
const bubbleId = ({ accountId, mailbox, uid }) => `${accountId}|${mailbox}|${uid}`;

export const useCodeBubbleStore = create((set, get) => ({
  // Newest first: [{ id, accountId, mailbox, uid, code, sender, subject, expiresAt }]
  bubbles: [],

  /** One bubble per message; offered again, it moves to the front with a fresh clock. */
  offer(bubble) {
    const id = bubbleId(bubble);
    const expiresAt = Date.now() + CODE_BUBBLE_TTL_MS;
    set(s => ({ bubbles: [{ ...bubble, id, expiresAt }, ...s.bubbles.filter(b => b.id !== id)].slice(0, MAX_BUBBLES) }));
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => get().dismiss(id), CODE_BUBBLE_TTL_MS));
  },

  dismiss(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set(s => ({ bubbles: s.bubbles.filter(b => b.id !== id) }));
  },

  clear() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    set({ bubbles: [] });
  },
}));
