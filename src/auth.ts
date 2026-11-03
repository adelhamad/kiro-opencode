export function loginInstruction(cli = 'kiro-cli') {
  return `Kiro authentication is required. Run ${JSON.stringify(cli)} login --use-device-flow in a terminal, finish signing in, then retry your request. OpenCode can stay open.`;
}

export function isAuthError(message: string) {
  return /authenticat|unauthori[sz]ed|invalid.grant|not logged in|log[ -]?in|sign[ -]?in|token.*expir|expir.*token/i.test(message);
}

export function killCli(child: ReturnType<typeof Bun.spawn>) {
  // The CLI may launch a child that still owns stdout or the login callback.
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
  }
  child.kill('SIGKILL');
}

// Drain both pipes so stderr cannot block the CLI. Do not expose login URLs or credentials.
export async function runCli(cli: string, args: string[], signal?: AbortSignal, timeout = 15_000) {
  signal?.throwIfAborted();
  const child = Bun.spawn([cli, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32' });
  let timedOut = false;
  const kill = () => killCli(child);
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    signal?.throwIfAborted();
    if (timedOut) throw new Error(`Kiro ${args[0]} check timed out. Check the CLI in a terminal, then retry.`);
    if (code !== 0) {
      if (isAuthError(stdout + stderr)) throw new Error(loginInstruction(cli));
      throw new Error(`Kiro ${args[0]} check failed (exit ${code}). Run the command in a terminal for details.`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}

// The model watcher re-checks every 30 seconds. Starting Kiro reuses a recent
// success instead of paying for another `whoami` (about 2 seconds) per launch.
const verified = new Map<string, number>();
export async function checkAuthentication(cli = 'kiro-cli', signal?: AbortSignal) {
  try { await runCli(cli, ['whoami', '--format', 'json'], signal); verified.set(cli, Date.now()); }
  catch (error) { verified.delete(cli); throw error; }
}
export async function ensureAuthenticated(cli = 'kiro-cli', signal?: AbortSignal, maxAge = 90_000) {
  if (Date.now() - (verified.get(cli) ?? -Infinity) < maxAge) return;
  await checkAuthentication(cli, signal);
}
export function forgetAuthentication() { verified.clear(); }
