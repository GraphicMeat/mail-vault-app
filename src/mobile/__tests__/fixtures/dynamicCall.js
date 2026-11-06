// Fixture for seam.test.js: a method name the scanner cannot read statically.
import { daemonCall } from '../../../services/daemonClient.js';

export const run = (name) => daemonCall(name);
