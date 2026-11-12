// The mail store with its workflow actions attached. Workflows that reach
// the store lazily import it from here, so whoever loads the store through
// a workflow gets a bound one at the same moment it used to.
import './bindStoreActions';
export { useMailStore } from '../../stores/mailStore';
