import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uninstall = process.argv.includes('--uninstall');
const targetArg = process.argv.find(arg => arg.startsWith('--config='));
const configDirectory = resolve(process.env.OPENCODE_CONFIG_DIR || resolve(homedir(), '.config', 'opencode'));
let target = targetArg?.slice('--config='.length);
if (!target) target = await Bun.file(resolve(configDirectory, 'opencode.jsonc')).exists() ? resolve(configDirectory, 'opencode.jsonc') : resolve(configDirectory, 'opencode.json');
target = resolve(target);
await mkdir(dirname(target), { recursive: true });
const exists = await Bun.file(target).exists();
const original = exists ? await readFile(target, 'utf8') : '{}\n';
const errors: ParseError[] = [];
const config = parse(original, errors, { allowTrailingComma: true });
if (errors.length || typeof config !== 'object' || !config || Array.isArray(config)) throw new Error('Invalid OpenCode JSON/JSONC. Configuration was not modified.');
if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('plugins must be an array. Configuration was not modified.');
const entries = config.plugins || [];
const matches = (entry: any) => (typeof entry === 'string' ? entry : entry?.package) === root;
// Migrate another local installation of this package without registering
// two copies with the same OpenCode plugin ID. Preserve its custom options.
const owned = new Set<any>();
for (const entry of entries) {
  const path = typeof entry === 'string' ? entry : entry?.package;
  if (matches(entry)) owned.add(entry);
  else if (!uninstall && typeof path === 'string' && path.startsWith('/')) {
    try { if ((await Bun.file(resolve(path, 'package.json')).json()).name === 'opencode-kiro') owned.add(entry); } catch {}
  }
}
const plugins = entries.filter((entry: any) => !owned.has(entry));
if (!uninstall) {
  const previous = entries.find((entry: any) => owned.has(entry));
  plugins.push(previous && typeof previous === 'object' ? { ...previous, package: root } : root);
}
const updated = applyEdits(original, modify(original, ['plugins'], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
if (updated !== original) {
  if (exists) await copyFile(target, target + `.backup-${Date.now()}`);
  await writeFile(target, updated, { mode: 0o600 });
}
console.log(`${uninstall ? 'Removed' : 'Installed'} Kiro plugin in ${target}`);
console.log(uninstall ? 'Restart OpenCode to unload the plugin.' : 'Restart OpenCode, then select a Kiro model with /models. No manual server is needed.');
