// Fixture for seam.test.js: the three seam calls reached through an alias the scanner cannot follow.
import { daemonCall as call, listen as on } from '../../transport.js';

const rpc = daemonCall;
const inv = invoke;
export const run = () => [call('mobile.ping'), on('mobile.sync.state', () => {}), rpc, inv];
