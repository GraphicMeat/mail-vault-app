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
// Frees a string mv_background_fetch answered.
void mv_free_string(char *s);
// A notification was tapped; `json` is its payload {accountId, folder, uid?}.
void mv_notification_tapped(const char *json);
// The system languages, most preferred first, comma separated.
void mv_set_languages(const char *csv);
// Perf-gate builds keep `runner` (the device check's run with no BGTask); others drop it.
void mv_set_device_check_runner(void (*runner)(void));

#endif
