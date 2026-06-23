import { listen } from '@tauri-apps/api/event';
import * as api from './api.js';
import { useSettingsStore } from '../stores/settingsStore.js';

class RestoreManager {
    constructor() {
        this._unlisten = null;
        this._initialized = false;
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        this._unlisten = await listen('restore-progress', (event) => {
            const progress = event.payload;
            const store = useSettingsStore.getState();
            store.setActiveRestore(progress);
            if (['completed', 'cancelled', 'failed'].includes(progress.status)) {
                store.clearRestoreDetected();
            }
        });
    }

    /**
     * @param {object} account - ImapConfig-shaped account (new server creds)
     * @param {string} accountId - account UUID (Maildir key)
     * @param {string[]} folders - real mailbox names to restore
     */
    async start(account, accountId, folders) {
        useSettingsStore.getState().setActiveRestore({
            account_id: accountId,
            email: account.email,
            total_emails: 0,
            uploaded_emails: 0,
            skipped_emails: 0,
            failed_emails: 0,
            current_folder: null,
            folder_progress: null,
            status: 'running',
        });
        await api.startRestore(account, accountId, folders);
    }

    async cancel() {
        await api.cancelRestore();
    }

    destroy() {
        if (this._unlisten) this._unlisten();
        this._unlisten = null;
        this._initialized = false;
    }
}

export const restoreManager = new RestoreManager();
