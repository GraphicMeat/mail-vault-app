// ── workflowPorts — how a store reaches a workflow without importing it ──
//
// Stores sit below the workflows (src/services/workflows/) in the import
// layers: a workflow imports stores, never the other way round. A store that
// still has to start a workflow (the keychain gate retries access, a notes
// card flags its copies) calls it through a named port. The workflow layer
// fills the ports once, in services/workflows/bindStoreActions.js.
//
// A port called before it is bound throws, so a missing binding fails at the
// first call instead of doing nothing.

const bound = new Map();

/** Fill ports: `{ name: fn }`. Binding a name again replaces it. */
export function bindWorkflowPorts(ports) {
  for (const [name, fn] of Object.entries(ports)) bound.set(name, fn);
}

/** A function that forwards to the port `name` at call time. */
export function workflowPort(name) {
  return (...args) => {
    const fn = bound.get(name);
    if (!fn) throw new Error(`workflow port "${name}" called before bindStoreActions`);
    return fn(...args);
  };
}
