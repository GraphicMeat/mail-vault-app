import { demoBackend } from './runtime.js';

export async function open(url) {
  // Newsletter CTAs are intentionally handled inside the browser demo. The
  // real shell would open a native browser; this adapter records the action
  // so the explanation panel can describe the boundary without navigating.
  await demoBackend.invoke('demo_emit_event', {
    event: 'demo:state',
    payload: { type: 'external-link', url: String(url || '') },
  });
  return { simulated: true };
}
