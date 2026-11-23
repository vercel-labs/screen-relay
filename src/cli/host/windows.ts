import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Failure } from '../output.js';
import { run } from './common.js';

/** Root of the MSYS2 install that `screen-relay install` sets up on Windows. */
export const MSYS2_ROOT = 'C:\\msys64';

/** MSYS2's bash, which runs build commands in its UCRT64 environment. Every caller reaches it through msys2Shell, which checks the installation first. */
const MSYS2_SHELL = `${MSYS2_ROOT}\\usr\\bin\\bash.exe`;

/** MSYS2's UCRT64 libraries, which relay-engine loads on Windows. */
const MSYS2_LIBRARIES = `${MSYS2_ROOT}\\ucrt64\\bin`;

/** The directories that the MSYS2 shell searches for the commands setup runs, in its own search order. */
const MSYS2_SEARCH = ['usr/local/bin', 'usr/bin', 'ucrt64/bin'];

/** The PATH that setup gives the MSYS2 shell, so it searches only the directories setup checks and whatever its login profile adds is not used. */
export const MSYS2_PATH = MSYS2_SEARCH.map((directory) => `/${directory}`).join(':');

/** Owners that setup trusts besides the signed-in account: SYSTEM, Administrators, and TrustedInstaller. */
const TRUSTED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);

/** Rights that let an account change a file, add entries to a directory, or replace an existing object. */
const WRITE_RIGHTS = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/** Rules that only apply to objects their trustee creates; who may create them is already settled by the parent's rules. */
const CREATOR_SIDS = new Set(['S-1-3-0', 'S-1-3-1', 'S-1-3-4']);

/** The decision this process made about the MSYS2 installation, so setup checks the tree once rather than for every step. */
let installation: Msys2Installation | undefined;

/** The decision this process made about the UCRT64 libraries that relay-engine loads, so starting the engine checks them once. */
let libraries: Msys2Installation | undefined;

/** One access rule as PowerShell reports it: the trustee's security identifier, its account name, and the rights it is granted. */
export type AclRule = { sid: string; name: string; rights: number };

/** The owner and allow rules of one path, whether it is a directory or a file, and whether it is a reparse point. */
export type AclObject = { path: string; kind: 'file' | 'directory'; reparse: boolean; owner: string; ownerName: string; rules: AclRule[] };

/** The allow rules of the MSYS2 paths, and the security identifier of the signed-in account. */
export type AclProbe = { current: string; objects: AclObject[] };

/** What setup found at the MSYS2 root: an absent root, an installation it runs, or a tree it will not run. */
export type Msys2Installation =
  | { state: 'missing'; root: string }
  | { state: 'trusted'; root: string; shell: string }
  | { state: 'untrusted'; root: string; reason: string };

/** The MSYS2 states that stop setup. */
export type Msys2Problem = Exclude<Msys2Installation, { state: 'trusted' }>;

/** The environment that runs relay-engine, with MSYS2's UCRT64 libraries first on PATH on Windows. Other platforms get the environment unchanged. */
export function engineEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32' || msys2Libraries().state !== 'trusted') return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: [MSYS2_LIBRARIES, env[key]].filter(Boolean).join(';') };
}

/** The directory to start the engine in on Windows: its own, so Windows does not search the caller's folder for the engine's DLLs. Undefined elsewhere. */
export function engineWorkingDirectory(engine: string): string | undefined {
  return process.platform === 'win32' ? dirname(engine) : undefined;
}

/** The MSYS2 installation on this machine, decided once per process. Call forgetMsys2Installation after setup changes the tree. */
export function msys2Installation(): Msys2Installation {
  installation ??= detectMsys2(MSYS2_SHELL, MSYS2_ROOT);
  return installation;
}

/** The MSYS2 installation as relay-engine uses it: only the UCRT64 libraries and the directories above them are checked, so running the engine does not read the whole tree. Use msys2Installation before running the MSYS2 shell. */
export function msys2Libraries(): Msys2Installation {
  return installation ?? (libraries ??= detectMsys2(MSYS2_LIBRARIES, MSYS2_LIBRARIES));
}

/** Drops the remembered decisions, so the next check reads the installation again. */
export function forgetMsys2Installation(): void {
  installation = undefined;
  libraries = undefined;
}

/** MSYS2's bash, after checking that setup trusts the installation it comes from. */
export function msys2Shell(): string {
  const found = msys2Installation();
  if (found.state === 'trusted') return found.shell;
  throw msys2Failure(found);
}

/** The failure that says setup will not run the MSYS2 tree it found, and what to do about it. The hint carries no backticks, because the CLI prints a backticked command in place of the hint. */
export function msys2Failure(found: Msys2Problem): Failure {
  if (found.state === 'untrusted') return new Failure('missing_dependency', `MSYS2 at ${found.root} is not a trusted installation`, msys2Fix(found));
  return new Failure('missing_dependency', 'MSYS2 is not installed', 'Run screen-relay install to create and install MSYS2 with the access rules it checks.');
}

/** The fix for an MSYS2 tree that setup will not run: delete it without running anything from it, and let setup install a fresh copy. */
export function msys2Fix(found: Extract<Msys2Installation, { state: 'untrusted' }>): string {
  return `${found.reason} Do not run any program from ${found.root}. Back up any files you need, delete ${found.root}, and run screen-relay install again. If winget then reports success without installing MSYS2, follow the manual steps in the Windows guide.`;
}

/** Whether the signed-in account, SYSTEM, Administrators, or TrustedInstaller owns every MSYS2 path that setup runs or loads, and no other account can write to it. */
export function trustedAcl(probe: AclProbe): { trusted: true } | { trusted: false; reason: string } {
  const trusted = (sid: string) => Boolean(sid) && (sid === probe.current || TRUSTED_SIDS.has(sid));
  for (const object of probe.objects) {
    if (object.reparse) return { trusted: false, reason: `${object.path} is a reparse point.` };
    if (!trusted(object.owner)) return { trusted: false, reason: `${object.path} is owned by ${object.ownerName}.` };
    for (const rule of object.rules) {
      if (!(rule.rights & WRITE_RIGHTS) || trusted(rule.sid) || CREATOR_SIDS.has(rule.sid)) continue;
      return { trusted: false, reason: `${object.path} lets ${rule.name} write to it.` };
    }
  }
  return { trusted: true };
}

/** Reads what the machine has at the MSYS2 root and whether setup trusts the required path and everything under scope. */
function detectMsys2(required: string, scope: string): Msys2Installation {
  if (!existsSync(MSYS2_ROOT)) return { state: 'missing', root: MSYS2_ROOT };
  if (!existsSync(required)) return { state: 'untrusted', root: MSYS2_ROOT, reason: `${required} is missing.` };
  const probe = probeMsys2Tree(MSYS2_ROOT, required, scope);
  if (!probe) return { state: 'untrusted', root: MSYS2_ROOT, reason: `screen-relay could not read the owner and access rules of ${MSYS2_ROOT}.` };
  const verdict = trustedAcl(probe);
  return verdict.trusted
    ? { state: 'trusted', root: MSYS2_ROOT, shell: MSYS2_SHELL }
    : { state: 'untrusted', root: MSYS2_ROOT, reason: verdict.reason };
}

/** The icacls arguments that give a new MSYS2 root its access rules. */
function privateMsys2Acl(root: string, account: string): string[] {
  return [root, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${account}:(OI)(CI)F`, '*S-1-5-32-545:(OI)(CI)RX'];
}

/** Creates a private MSYS2 root and returns a function that removes that same root if it is still empty. */
export function createPrivateMsys2Root(root = MSYS2_ROOT): (() => boolean) | null {
  if (process.platform !== 'win32') return null;
  try {
    mkdirSync(root);
  } catch {
    return null;
  }
  let identity: { dev: bigint; ino: bigint };
  try {
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.ino === 0n) return null;
    identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
  const discard = () => {
    try {
      const stat = lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
      rmdirSync(root);
      return true;
    } catch {
      return false;
    } finally {
      forgetMsys2Installation();
    }
  };
  const fail = () => { discard(); return null; };
  const emptyBefore = (() => {
    try { return readdirSync(root).length === 0; } catch { return false; }
  })();
  if (!emptyBefore) return fail();
  const first = probeMsys2Tree(root);
  if (!first || !/^S-\d+(-\d+)+$/.test(first.current)) return fail();
  if (first.objects.some((object) => object.reparse)) return fail();
  const emptyBeforeAcl = (() => {
    try { return readdirSync(root).length === 0; } catch { return false; }
  })();
  if (!emptyBeforeAcl) return fail();
  const applied = run([systemTool('icacls.exe'), ...privateMsys2Acl(root, first.current)], { timeout: 120000 }).status === 0;
  const probe = probeMsys2Tree(root);
  const emptyAfter = (() => {
    try { return readdirSync(root).length === 0; } catch { return false; }
  })();
  forgetMsys2Installation();
  if (!applied || !probe || !trustedAcl(probe).trusted || !emptyAfter) return fail();
  return discard;
}

/** Reads representative owner and allow rules for the MSYS2 tree without following reparse points. Only scope, everything under it, and the directories above it are read. */
export function probeMsys2Tree(root = MSYS2_ROOT, requiredPath?: string, scope = root): AclProbe | null {
  const literal = (path: string) => `'${path.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$root = ${literal(root)}`,
    `$required = ${requiredPath ? literal(requiredPath) : '$null'}`,
    `$scope = ${literal(`${scope}\\`)}`,
    '$stack = New-Object System.Collections.Stack',
    '$stack.Push((Get-Item -LiteralPath $root -Force))',
    '$sections = [System.Security.AccessControl.AccessControlSections] "Access,Owner"',
    '$seen = @{}',
    '$objects = @(while ($stack.Count -gt 0) {',
    '  $item = $stack.Pop()',
    '  $path = $item.FullName',
    '  $isDirectory = $item.PSIsContainer',
    '  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {',
    '    [pscustomobject]@{ path = $path; directory = $isDirectory; reparse = $true }',
    '    continue',
    '  }',
    '  if ($isDirectory) { foreach ($child in (Get-ChildItem -LiteralPath $path -Force)) {',
    "    $inside = $child.FullName + '\\'",
    '    if ($inside.StartsWith($scope, [StringComparison]::OrdinalIgnoreCase) -or $scope.StartsWith($inside, [StringComparison]::OrdinalIgnoreCase)) { $stack.Push($child) }',
    '  } }',
    '  $acl = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($path, $sections) } else { [System.IO.File]::GetAccessControl($path, $sections) }',
    '  $key = "$isDirectory|" + $acl.GetSecurityDescriptorSddlForm($sections)',
    '  if ($seen.ContainsKey($key) -and $path -ne $required) { continue }',
    '  $seen[$key] = $true',
    '  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])',
    '  $ownerName = try { $owner.Translate([System.Security.Principal.NTAccount]).Value } catch { $owner.Value }',
    '  $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow } | ForEach-Object {',
    '    $sid = if ($_.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) { $_.IdentityReference } else { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) }',
    '    $name = try { $sid.Translate([System.Security.Principal.NTAccount]).Value } catch { $sid.Value }',
    '    [pscustomobject]@{ sid = $sid.Value; name = $name; rights = [int]$_.FileSystemRights }',
    '  })',
    '  [pscustomobject]@{ path = $path; directory = $isDirectory; reparse = $false; owner = $owner.Value; ownerName = $ownerName; rules = $rules }',
    '})',
    '$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '[pscustomobject]@{ current = $current; objects = $objects } | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120000 });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const decoded = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as { current?: unknown; objects?: RawObject | RawObject[] };
    const objects = (Array.isArray(decoded.objects) ? decoded.objects : decoded.objects ? [decoded.objects] : []).map((object): AclObject => ({
      path: String(object.path ?? ''),
      kind: object.directory === true ? 'directory' : 'file',
      reparse: object.reparse === true,
      owner: String(object.owner ?? ''),
      ownerName: String(object.ownerName ?? object.owner ?? ''),
      rules: (Array.isArray(object.rules) ? object.rules : object.rules ? [object.rules] : []).map((rule) => ({
        sid: String(rule.sid ?? ''),
        name: String(rule.name ?? rule.sid ?? ''),
        rights: Number(rule.rights ?? 0),
      })),
    }));
    const normalized = (path: string) => path.replace(/[\\/]+$/, '').toLowerCase();
    const has = (path: string) => objects.some((object) => normalized(object.path) === normalized(path));
    if (!has(root) || (requiredPath && !has(requiredPath))) return null;
    return { current: String(decoded.current ?? ''), objects };
  } catch {
    return null;
  }
}

/** A path from the probe as PowerShell wrote it, before the shape is checked. */
type RawObject = { path?: unknown; directory?: unknown; reparse?: unknown; owner?: unknown; ownerName?: unknown; rules?: RawRule | RawRule[] };

/** One rule from the probe as PowerShell wrote it, before the shape is checked. */
type RawRule = { sid?: unknown; name?: unknown; rights?: unknown };

/** Absolute path of a tool in the Windows system folder, so a same-named file in the working directory cannot stand in for it. */
function systemTool(...parts: string[]): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
}

/** Absolute path of winget, or null when LOCALAPPDATA is not set. */
export function wingetPath(): string | null {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe') : null;
}

/** The Windows session id of this process, or null when PowerShell cannot report it. */
export function windowsSessionId(): number | null {
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId'], { timeout: 15000 });
  const text = result.stdout?.trim() ?? '';
  return result.status === 0 && /^\d+$/.test(text) ? Number(text) : null;
}

/** The creation time of a Windows process as a FILETIME string, or null when it cannot be read. */
export function windowsStartTime(pid: number): string | null {
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { timeout: 15000 });
  const text = result.stdout?.trim() ?? '';
  return result.status === 0 && /^\d+$/.test(text) ? text : null;
}

/** Ends a process and every process it started. A failure is ignored because the process may already be gone. */
export function killTree(pid: number): void {
  run([systemTool('taskkill.exe'), '/PID', String(pid), '/T', '/F'], { timeout: 10000 });
}
