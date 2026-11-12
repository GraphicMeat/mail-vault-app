// A slice declares an action that a workflow implements under the same key,
// so the shape of the store is visible here. The workflow layer replaces it
// (services/workflows/bindStoreActions.js); calling it unreplaced is loud.
export const unboundAction = (name) => () => {
  throw new Error(`mailStore action "${name}" called before bindStoreActions`);
};
