// Build the mock IMAP server binary once before the integration suite runs.
import { buildMockServer } from '../e2e/mockImap.js';

export default function setup() {
  buildMockServer();
}
