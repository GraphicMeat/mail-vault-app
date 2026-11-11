// MailVault mobile: the shell's C exports Background.swift calls (src-tauri-mobile/src/background.rs).
// Declared here, in C, so Swift calls them with the C calling convention. The definitions are in
// the shell's Rust library, linked into the app.
#ifndef MV_SHELL_H
#define MV_SHELL_H

#include <stdint.h>

// One background run inside budget_ms (counted from the call). Answers {channel, notes, commit?}
// JSON; free it with mv_free_string. Blocks: call it off the main thread.
char *mv_background_fetch(uint32_t budget_ms);
// The run that answered `token` had its notes posted: its mail counts as notified.
void mv_background_commit(const char *token);
// Frees a string an mv_* call answered (mv_background_fetch, mv_store_verify, mv_store_account_token).
void mv_free_string(char *s);
// A notification was tapped; `json` is its payload {accountId, folder, uid?}.
void mv_notification_tapped(const char *json);
// The system languages, most preferred first, comma separated.
void mv_set_languages(const char *csv);
// One store transaction to the engine (src-tauri-mobile/src/store.rs): `json` is
// {platform, jws, productId?, restore?, appTransaction?}. Answers {answered, premium | code} JSON;
// finish the transaction only when `answered`. Free it with mv_free_string. Blocks: call it off
// the main thread.
char *mv_store_verify(const char *json);
// This install's StoreKit appAccountToken (a one-way hash of the install id), "" when it cannot
// be had. Free it with mv_free_string. Blocks: call it off the main thread.
char *mv_store_account_token(void);
// Perf-gate builds keep `runner` (the device check's run with no BGTask); others drop it.
void mv_set_device_check_runner(void (*runner)(void));

#endif
