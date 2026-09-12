import { demoBackend } from './runtime.js';

export async function listen(event, callback) {
  return demoBackend.on(event, callback);
}

export async function emit(event, payload) {
  // The production event API sends an event object with a payload property.
  for (const callback of []) callback({ payload });
  return demoBackend.invoke('demo_emit_event', { event, payload });
}
