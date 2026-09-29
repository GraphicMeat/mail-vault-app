/**
 * Archive (& back up) & delete from server: the shell is a bookmark FORWARDER.
 * The daemon runs the job; the app only resolves the backup drive's
 * security-scoped bookmark, parks it for the job's life and lets it go.
 *
 * CI never runs `cargo test -p mailvault`, so this reads the sources directly
 * (same pattern as `backupCopyUidsForwarder.test.js`). Each assertion pins one
 * hop of the route; a missing hop fails at runtime as "command not found" or
 * as a job with no drive to write to.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as transport from '../../src/services/transport.js';

const read = (p) => readFileSync(p, 'utf8');
const main = read('src-tauri/src/main.rs');
const handlerStart = main.indexOf('generate_handler![');
const handlerList = main.slice(handlerStart, main.indexOf(']', handlerStart));
const shell = read('src-tauri/src/abd.rs');
const channel = read('src-tauri/src/daemon_channel.rs');
const backupRs = read('src-tauri/src/backup.rs');

/** Source with `//` comment lines and the `#[cfg(test)]` module dropped. */
const prod = (s) => {
  const cut = s.indexOf('#[cfg(test)]');
  return (cut === -1 ? s : s.slice(0, cut))
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
};
const shellProd = prod(shell);

/** The body of `fn <name>` (any visibility), up to the next top-level item. */
const fnBody = (src, name) => {
  const m = new RegExp(`\\n(?:pub(?:\\([a-z]+\\))? )?(?:async )?fn ${name}\\b`).exec(src);
  expect(m, `${name} is declared`).not.toBeNull();
  const rest = src.slice(m.index + 1);
  const next = rest.search(/\n(?:#\[|pub |fn |\/\/\/ )/m);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('the three abd commands are shell forwarders', () => {
  it.each(['abd_summarize', 'abd_start', 'abd_attach'])('%s is a registered Tauri command', (name) => {
    expect(handlerList).toMatch(new RegExp(`\\babd::${name}\\b`));
    expect(shell).toMatch(new RegExp(`#\\[tauri::command\\]\\s*pub async fn ${name}\\(`));
  });

  it('are NOT daemon-owned: the renderer must go through the shell that holds the bookmark', () => {
    for (const name of ['abd_summarize', 'abd_start', 'abd_attach', 'abd.attach_mirror']) {
      expect(transport.DAEMON_OWNED.has(name), name).toBe(false);
    }
  });

  it('the daemon-side control methods stay out of DAEMON_OWNED (called through daemonCall)', () => {
    for (const m of ['preview', 'status', 'pause', 'resume', 'cancel', 'set_token', 'dismiss']) {
      expect(transport.DAEMON_OWNED.has(`abd.${m}`), `abd.${m}`).toBe(false);
    }
  });

  it('the state and the module are registered', () => {
    expect(main).toMatch(/^mod abd;$/m);
    expect(main).toMatch(/\.manage\(abd::HeldAbdPaths::default\(\)\)/);
  });

  it('every command runs on the blocking pool and forwards the right daemon method', () => {
    const summarize = fnBody(shellProd, 'abd_summarize');
    const start = fnBody(shellProd, 'abd_start');
    const attach = fnBody(shellProd, 'abd_attach');
    for (const b of [summarize, start, attach]) expect(b).toMatch(/spawn_blocking/);
    expect(shellProd).toMatch(/"abd\.summarize"/);
    expect(shellProd).toMatch(/"abd\.start"/);
    expect(shellProd).toMatch(/"abd\.attach_mirror"/);
  });

  it('does no file work itself and speaks no network', () => {
    expect(shellProd).not.toMatch(/std::fs|fs::write|fs::copy|vault_files::|reqwest|ImapPool/);
  });
});

describe('the drive hold is its own map, released by abd frames only', () => {
  it('HeldAbdPaths is separate from HeldBackupPaths', () => {
    expect(shellProd).toMatch(/pub struct HeldAbdPaths\(pub Mutex<HashMap<String, String>>\)/);
    expect(shellProd).not.toMatch(/HeldBackupPaths/);
    expect(prod(backupRs)).not.toMatch(/HeldAbdPaths|abd-progress/);
  });

  it('the channel releases on the terminal abd-progress frame, on a lag and on a reconnect', () => {
    expect(channel).toMatch(/name == crate::abd::ABD_PROGRESS/);
    expect(channel).toMatch(/crate::abd::release_after_frame\(app, &frame\)/);
    expect(channel).toMatch(/crate::abd::release_all\(app, "the daemon event stream lagged"\)/);
    expect(channel).toMatch(/crate::abd::release_all\(&app, "the daemon channel reconnected"\)/);
    expect(shellProd).toMatch(/const ABD_PROGRESS: &str = "abd-progress"/);
  });

  it('the frame is re-emitted to the frontend before the hold is released, like backup-progress', () => {
    const emit = channel.indexOf('app.emit(&name, payload)');
    expect(emit).toBeGreaterThan(-1);
    expect(channel.indexOf('crate::abd::release_after_frame(app, &frame)')).toBeGreaterThan(emit);
  });

  it('backup-progress handling is untouched', () => {
    expect(channel).toMatch(/name == "backup-progress"/);
    expect(channel).toMatch(/crate::backup::release_after_terminal_progress\(app, &progress\)/);
    expect(channel).toMatch(/crate::export_folder::release_after_final_frame\(app, &frame\)/);
  });

  it('a frame releases on finished:true or a drive_unavailable pause, nothing else', () => {
    const pred = fnBody(shellProd, 'frame_releases_drive');
    expect(pred).toMatch(/"finished"/);
    expect(pred).toMatch(/"paused"/);
    expect(pred).toMatch(/"drive_unavailable"/);
    expect(pred).not.toMatch(/sign_in_needed|"user"|"waiting"/);
  });
});

describe('archive-only mode never touches the backup drive', () => {
  it('the slot is resolved only after the archive-only early return, in start and summarize', () => {
    for (const name of ['start_flow', 'summarize_flow']) {
      const body = fnBody(shellProd, name);
      const early = body.indexOf('is_backup_mode');
      const resolve = body.indexOf('ports.resolve()');
      expect(early, name).toBeGreaterThan(-1);
      expect(resolve, name).toBeGreaterThan(early);
      // the archive-only branch returns before any resolve
      expect(body.slice(early, resolve)).toMatch(/return ports\.call\(/);
    }
  });

  it('a backup-mode start parks the drive before it calls the daemon', () => {
    const body = fnBody(shellProd, 'start_flow');
    expect(body.indexOf('held.hold(')).toBeGreaterThan(-1);
    // the archive-only branch calls earlier and holds nothing; the LAST call is the backup one
    expect(body.indexOf('held.hold(')).toBeLessThan(body.lastIndexOf('ports.call("abd.start"'));
    expect(body).toMatch(/ERR_NO_BACKUP_DRIVE/);
    expect(shellProd).toMatch(/const ERR_NO_BACKUP_DRIVE: &str = "E_ABD_NO_BACKUP_DRIVE: /);
  });

  it('a summarize never parks anything', () => {
    expect(fnBody(shellProd, 'summarize_flow')).not.toMatch(/held\./);
  });
});
