#!/usr/bin/env python3
"""One-button probe: can the signed, SANDBOXED daemon binary bind the OAuth2
loopback callback listener (127.0.0.1:19876)?

Task 5.7 moved OAuth2Manager (src-core/src/oauth2.rs) out of the app and into
the daemon (src-daemon). Its `ensure_callback_server` binds that port lazily,
on the first `oauth2_auth_url` call. `com.apple.security.network.server` was
added to src-daemon/entitlements.plist in Task 5.1, but whether a spawned,
SEPARATELY-SIGNED, sandboxed child process can actually bind a *listening*
socket under entitlement inheritance has never been tested -- P0.1's probe
only proved file-access and SCM_RIGHTS fd-passing inheritance, not sockets.

This is unverified per the plan's "Two platform gates" section and MUST be
run by Rokas on his own Mac against a real signed build; it is not run as
part of this task and does not gate the merge (same category as the still-
open backup-bookmark-scope probe, docs/superpowers/ledgers/
2026-09-16-daemon-shell-phase3/progress.md).

── How to run it ────────────────────────────────────────────────────────────
1. Build and launch the SIGNED app normally (`npm run tauri:build`, then open
   the built .app -- NOT `npm run tauri:dev`, which runs an unsigned daemon
   binary and would only prove the unsandboxed case).
2. No account or login needed -- oauth2_auth_url only builds an auth URL and
   starts the callback listener; it never talks to Microsoft or Google.
3. `python3 scripts/probe-oauth2-loopback.py`
4. Read the PASS/FAIL line. Exit code 0 = PASS, 1 = FAIL/inconclusive.

No GUI interaction: this talks directly to the daemon's existing JSON-RPC
Unix socket (~/.mailvault/mv.sock, same handshake protocol as the real app,
see src-daemon/src/ipc.rs / server.rs::handle_connection) and then does a
plain TCP connect to check whether something is actually listening on
127.0.0.1:19876 -- the same way a browser's redirect would reach it.
"""
import json
import os
import socket
import subprocess
import sys
import time

IPC_DIR = os.path.expanduser("~/.mailvault")
SOCK_PATH = os.path.join(IPC_DIR, "mv.sock")
TOKEN_PATH = os.path.join(IPC_DIR, "mv.token")
DAEMON_PID_PATH = os.path.expanduser(
    "~/Library/Application Support/com.mailvault.app/daemon.pid"
)
CALLBACK_PORT = 19876


def rpc_call(sock: socket.socket, obj: dict) -> dict:
    sock.sendall((json.dumps(obj) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("daemon closed the connection mid-response")
        buf += chunk
    return json.loads(buf.decode())


def daemon_pid() -> "int | None":
    try:
        with open(DAEMON_PID_PATH) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def pid_listening_on_port(port: int) -> "int | None":
    """Cross-check WHO holds the port, so a stale leftover dev daemon can't
    produce a false PASS for the signed/sandboxed one this probe is about."""
    try:
        out = subprocess.run(
            ["lsof", f"-iTCP:{port}", "-sTCP:LISTEN", "-n", "-P", "-t"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        pids = [int(p) for p in out.splitlines() if p.strip()]
        return pids[0] if pids else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def main() -> int:
    if not os.path.exists(SOCK_PATH):
        print(f"FAIL: no daemon socket at {SOCK_PATH} -- is the app running?")
        return 1
    if not os.path.exists(TOKEN_PATH):
        print(f"FAIL: no daemon token at {TOKEN_PATH}")
        return 1
    token = open(TOKEN_PATH).read().strip()

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(SOCK_PATH)

        auth = rpc_call(s, {"token": token})
        if not (auth.get("result") or {}).get("authenticated"):
            print(f"FAIL: daemon rejected the auth handshake: {auth}")
            return 1

        resp = rpc_call(s, {"method": "oauth2_auth_url", "params": {}, "id": 1})
        result = resp.get("result") or {}
        if not result.get("authUrl"):
            print(f"FAIL: oauth2_auth_url did not return an authUrl: {resp}")
            return 1
        print(f"oauth2_auth_url ok (state={result.get('state')}) -- callback server bind requested")

    expected_pid = daemon_pid()

    # ensure_callback_server's bind runs on a spawned tokio task -- give it a
    # moment, then poll for the listener actually accepting connections.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", CALLBACK_PORT), timeout=1):
                pass
        except OSError:
            time.sleep(0.25)
            continue

        holder = pid_listening_on_port(CALLBACK_PORT)
        if expected_pid is not None and holder is not None and holder != expected_pid:
            print(
                f"INCONCLUSIVE: something IS listening on 127.0.0.1:{CALLBACK_PORT}, "
                f"but pid {holder} holds it, not the daemon pid {expected_pid} from "
                f"{DAEMON_PID_PATH} -- likely a stale/leftover process from a previous "
                f"run. Kill it and rerun this probe against a fresh launch."
            )
            return 1

        print(
            f"PASS: the daemon (pid {holder if holder is not None else expected_pid}) "
            f"is listening on 127.0.0.1:{CALLBACK_PORT}."
        )
        return 0

    print(
        f"FAIL: nothing accepted a TCP connection on 127.0.0.1:{CALLBACK_PORT} within 5s "
        f"-- the sandboxed daemon likely could not bind the loopback listener. Check "
        f"daemon.log (Help > Export Logs, or ~/Library/Application Support/"
        f"com.mailvault.app/logs/daemon.log) for '[OAuth2]' / 'Failed to bind callback "
        f"server' / 'Operation not permitted'."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
