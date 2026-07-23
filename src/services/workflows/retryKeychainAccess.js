// ── retryKeychainAccess workflow — clears the credentials cache and re-activates ──

import * as db from '../db';


// ── retryKeychainAccess workflow ──

export async function retryKeychainAccess() {
  const { useMailStore } = await import('../../stores/mailStore');
  const get = () => useMailStore.getState();

  const { activeAccountId } = get();

  console.log('[mailStore] Retrying keychain access...');

  try {
    db.clearCredentialsCache();

    const freshAccounts = await db.getAccounts();

    if (freshAccounts.length === 0) {
      console.warn('[mailStore] No accounts found after keychain retry');
      useMailStore.setState({
        connectionError: 'No accounts found. Please add your account in Settings.',
        connectionErrorType: 'passwordMissing'
      });
      return false;
    }

    const activeAccount = freshAccounts.find(a => a.id === activeAccountId);
    const hasCredentials = activeAccount && (activeAccount.password || (activeAccount.authType === 'oauth2' && activeAccount.oauth2AccessToken));

    if (!hasCredentials) {
      console.warn('[mailStore] Active account still has no credentials after keychain retry');
      useMailStore.setState({
        accounts: freshAccounts,
        connectionError: 'Password not found. Please re-enter your password in Settings.',
        connectionErrorType: 'passwordMissing'
      });
      return false;
    }

    console.log('[mailStore] Keychain retry successful, reloading...');
    useMailStore.setState({
      accounts: freshAccounts,
      connectionStatus: 'connecting',
      connectionError: null,
      connectionErrorType: null
    });

    const { activeMailbox } = get();
    // Pass _backgroundRefresh so activateAccount skips the `emails: []` wipe
    // at lines 430-442. Without this, retrying after a dismissed keychain
    // prompt blanks the already-rendered cached mailbox mid-retry.
    await get().activateAccount(activeAccountId, activeMailbox || 'INBOX', { _backgroundRefresh: true });
    return true;
  } catch (error) {
    console.error('[mailStore] Keychain retry failed:', error);
    useMailStore.setState({
      connectionError: 'Could not access Keychain. Please re-enter your password in Settings.',
      connectionErrorType: 'passwordMissing'
    });
    return false;
  }
}
