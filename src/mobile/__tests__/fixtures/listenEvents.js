// Fixture for seam.test.js: literal event subscriptions, one of them to an event nobody emits.
import { listen } from '../../transport.js';

export const off = [listen('mobile.nope', () => {}), listen('mobile.sync.state', () => {})];
