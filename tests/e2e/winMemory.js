// Windows side of ram-footprint.test.js.
//
// The number is the private working set: Task Manager's "Memory" column, the
// nearest Windows twin of the macOS physical footprint the Mac run reports.
// Read from the raw perf class, never Get-Counter: counter NAMES are
// localized, and the test box runs lt-LT.
//
// WebView2 runs out of process like WKWebView does, as msedgewebview2.exe
// children of the app. An installed MailVault and every other WebView2 app on
// the box share those image names, so ownership is by tree: this checkout's
// own mailvault.exe / mailvault-daemon.exe, plus everything below them.
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const OWN_EXES = new Set(['mailvault.exe', 'mailvault-daemon.exe']);

/** The roots (our exes under `repoRoot`) and every process descended from one. */
export function ownedTree(procs, repoRoot) {
  const prefix = resolve(repoRoot).toLowerCase() + sep;
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const owned = new Map();
  const queue = procs.filter((p) => OWN_EXES.has(p.name?.toLowerCase())
    && p.path?.toLowerCase().startsWith(prefix));
  while (queue.length) {
    const p = queue.shift();
    if (owned.has(p.pid)) continue;
    owned.set(p.pid, p);
    queue.push(...(kids.get(p.pid) || []).filter((c) => c.pid !== p.pid));
  }
  return [...owned.values()];
}

/** `msedgewebview2 (renderer)` etc.: one image name, five jobs. */
export function roleOf(p) {
  const name = (p.name || '').replace(/\.exe$/i, '');
  if (name.toLowerCase() !== 'msedgewebview2') return name;
  const type = (p.cmd || '').match(/--type=([\w-]+)/)?.[1];
  const sub = (p.cmd || '').match(/--utility-sub-type=[\w.]*?(\w+)Service\b/)?.[1];
  return `${name} (${type ? (sub ? `${type}: ${sub}` : type) : 'browser'})`;
}

const PS_SNAPSHOT = `
$ws = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $ws[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate }
Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name;
    path = $_.ExecutablePath; cmd = $_.CommandLine; privateWS = $ws[[int]$_.ProcessId];
    ws = [int64]$_.WorkingSetSize; peakWS = [int64]$_.PeakWorkingSetSize * 1024 }
} | ConvertTo-Json -Compress`;

const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const toMB = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576 * 10) / 10);

/**
 * One reading of every process this checkout owns. `mb` is the private working
 * set; `wsMB`/`peakWsMB` are the TOTAL working set and its peak (shared pages
 * included), so they are not comparable to `mb` or to a Mac peak.
 */
export function windowsSample(repoRoot) {
  const out = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded(PS_SNAPSHOT)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return ownedTree(JSON.parse(out), repoRoot).map((p) => ({
    pid: p.pid, who: roleOf(p), path: p.path,
    mb: toMB(p.privateWS), wsMB: toMB(p.ws), peakWsMB: toMB(p.peakWS),
  }));
}

const PS_CAPTURE = `
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int a, out RECT r, int s);
public struct RECT { public int L, T, R, B; }
'@
[W.U]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4)) | Out-Null
$h = (Get-Process -Id @@PID@@).MainWindowHandle
[W.U]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600
$r = New-Object W.U+RECT
[W.U]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('@@OUT@@', [System.Drawing.Imaging.ImageFormat]::Png)
"$($bmp.Width)x$($bmp.Height)"`;

/**
 * The app window as the screen shows it, native frame included, in physical
 * pixels. Needs the interactive desktop: from ssh's session 0 there is no
 * screen, and a locked one comes back black.
 */
export function captureWindow(pid, outPng) {
  const script = PS_CAPTURE.replace('@@PID@@', String(pid)).replace('@@OUT@@', outPng.replace(/'/g, "''"));
  return execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded(script)],
    { encoding: 'utf8', windowsHide: true }).trim();
}
