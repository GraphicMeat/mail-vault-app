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
import { rustNonTestCode, shellSource } from './helpers/rustSources.js';
import * as transport from '../../src/services/transport.js';

const read = (p) => readFileSync(p, 'utf8');
const main = shellSource();
const handlerStart = main.indexOf('generate_handler![');
const handlerList = main.slice(handlerStart, main.indexOf(']', handlerStart));
const shell = read('src-tauri/src/abd.rs');
const channel = read('src-tauri/src/daemon_channel.rs');
const backupRs = read('src-tauri/src/backup.rs');
const lease = read('src-tauri/src/native_lease.rs');
/** One row of the shell's job-hold table (`native_lease::KINDS`). */
const leaseRow = (job) => {
  const m = new RegExp(`Kind \\{\\s*job: Job::${job},[^}]*\\}`).exec(lease);
  expect(m, `${job} has a row`).not.toBeNull();
  return m[0];
};

/** Source with `//` comments and the test items dropped. */
const prod = rustNonTestCode;
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
    expect(main).toMatch(/\.manage\(native_lease::Leases::default\(\)\)/);
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

describe('the drive hold is its own kind, released by abd frames only', () => {
  it('the abd hold and a backup run hold are separate kinds of the one lease table', () => {
    expect(leaseRow('Abd')).toMatch(/event: crate::abd::ABD_PROGRESS,/);
    expect(leaseRow('BackupRun')).toMatch(/event: crate::backup::BACKUP_PROGRESS,/);
    expect(shellProd).not.toMatch(/Job::BackupRun|HeldBackupPaths/);
    expect(prod(backupRs)).not.toMatch(/Job::Abd|abd-progress/);
  });

  it('the channel releases on the terminal abd-progress frame, on a lag and on a reconnect', () => {
    expect(leaseRow('Abd')).toMatch(/ends: crate::abd::frame_releases_drive,/);
    expect(leaseRow('Abd')).toMatch(/release_on_reset: true,/);
    expect(channel).toMatch(/crate::native_lease::is_lease_event\(&name\)/);
    expect(channel).toMatch(/crate::native_lease::after_event\(app, &name, &frame\)/);
    expect(channel).toMatch(/crate::native_lease::release_on_reset\(app, "the daemon event stream lagged"\)/);
    expect(channel).toMatch(/crate::native_lease::release_on_reset\(&app, "the daemon channel reconnected"\)/);
    expect(shellProd).toMatch(/const ABD_PROGRESS: &str = "abd-progress"/);
  });

  it('the frame is re-emitted to the frontend before the hold is released, like backup-progress', () => {
    const emit = channel.indexOf('app.emit(&name, payload)');
    expect(emit).toBeGreaterThan(-1);
    expect(channel.indexOf('crate::native_lease::after_event(app, &name, &frame)')).toBeGreaterThan(emit);
  });

  it('backup-progress handling is untouched: a legacy run keeps its mirror across a reconnect', () => {
    expect(prod(backupRs)).toMatch(/const BACKUP_PROGRESS: &str = "backup-progress"/);
    expect(leaseRow('BackupRun')).toMatch(/ends: crate::backup::legacy_run_over,/);
    expect(leaseRow('BackupRun')).toMatch(/release_on_reset: false,/);
    expect(leaseRow('Export')).toMatch(/event: crate::export_folder::EXPORT_PROGRESS,/);
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
    expect(body.indexOf('held.call_holding(')).toBeGreaterThan(-1);
    // the archive-only branch calls earlier and holds nothing; the LAST call is the
    // backup one, run by `call_holding` after it parks the drive
    expect(body.indexOf('held.call_holding(')).toBeLessThan(body.lastIndexOf('ports.call("abd.start"'));
    expect(body).toMatch(/ERR_NO_BACKUP_DRIVE/);
    expect(shellProd).toMatch(/const ERR_NO_BACKUP_DRIVE: &str = "E_ABD_NO_BACKUP_DRIVE: /);
  });

  it('a summarize never parks anything', () => {
    expect(fnBody(shellProd, 'summarize_flow')).not.toMatch(/held\./);
  });
});
