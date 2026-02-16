// Pure utility functions for keychain data parsing.
// Extracted so they can be unit-tested without Tauri/browser globals.

// Parse a keychain value into an account object.
// New format: JSON string with full account data.
// Legacy format: plain password string.
export function parseKeychainValue(id, value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && parsed.email) return parsed;
  } catch { /* not JSON — legacy plain password */ }
  return { id, password: value };
}

export function getAccountsFromKeychain(data) {
  return Object.entries(data).map(([id, value]) => parseKeychainValue(id, value));
}
