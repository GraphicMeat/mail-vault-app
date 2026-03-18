import { listen } from '@tauri-apps/api/event';
import * as api from './api.js';
import { useSettingsStore } from '../stores/settingsStore.js';

class MigrationManager {
    constructor() {
        this._unlisten = null;
        this._initialized = false;
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        // Listen to migration-progress events from Rust
        this._unlisten = await listen('migration-progress', (event) => {
            const progress = event.payload;
            const store = useSettingsStore.getState();

            store.setActiveMigration(progress);

            // When migration completes, fails, or is cancelled -- add to history
            if (['completed', 'failed', 'cancelled'].includes(progress.status)) {
                store.addMigrationHistory({
                    id: Date.now().toString(),
                    sourceEmail: progress.source_email,
                    destEmail: progress.dest_email,
                    totalEmails: progress.migrated_emails + progress.skipped_emails + progress.failed_emails,
                    migratedEmails: progress.migrated_emails,
                    skippedEmails: progress.skipped_emails,
                    failedEmails: progress.failed_emails,
                    duration: progress.elapsed_seconds,
                    status: progress.status,
                    completedAt: new Date().toISOString(),
                    folderCount: progress.folders?.length || 0,
                });
            }
        });

        // Check for incomplete migration on startup
        await this.checkForIncompleteMigration();
    }

    async checkForIncompleteMigration() {
        try {
            const state = await api.getMigrationState();
            if (state && state.status === 'paused') {
                useSettingsStore.getState().setIncompleteMigration(state);
            }
        } catch (e) {
            console.warn('Failed to check migration state:', e);
        }
    }

    async discardIncompleteMigration() {
        try {
            await api.clearMigrationState();
            useSettingsStore.getState().clearIncompleteMigration();
        } catch (e) {
            console.warn('Failed to clear migration state:', e);
        }
    }

    destroy() {
        if (this._unlisten) {
            this._unlisten();
            this._unlisten = null;
        }
        this._initialized = false;
    }
}

export const migrationManager = new MigrationManager();
