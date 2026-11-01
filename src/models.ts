import { checkAuthentication, runCli } from './auth';

export interface KiroModel { model_id: string; model_name: string; context_window_tokens?: number; description?: string }
export async function discoverModels(cli = 'kiro-cli', signal?: AbortSignal): Promise<KiroModel[]> {
  await checkAuthentication(cli, signal);
  const output = await runCli(cli, ['chat', '--no-interactive', '--list-models', '--format', 'json'], signal);
  let data;
  try { data = JSON.parse(output); } catch { throw new Error('Kiro returned invalid model JSON'); }
  if (!Array.isArray(data.models) || !data.models.length || data.models.some((model: KiroModel) =>
    !model || typeof model.model_id !== 'string' || !model.model_id || typeof model.model_name !== 'string')) {
    throw new Error('Kiro returned an empty or invalid model list');
  }
  return data.models;
}

// A failed discovery must not reject plugin setup. Retry serially and cancel on unload.
export function watchModels(options: {
  cli: string; signal: AbortSignal; interval?: number;
  update(models: KiroModel[]): Promise<void>;
  report(message: string): void;
}) {
  return (async () => {
    let previous = '';
    let lastError = '';
    while (!options.signal.aborted) {
      try {
        const models = await discoverModels(options.cli, options.signal);
        const current = JSON.stringify(models);
        if (current !== previous) { await options.update(models); previous = current; }
        lastError = '';
      } catch (error) {
        if (options.signal.aborted) return;
        const message = String(error);
        if (message !== lastError) options.report(message);
        lastError = message;
      }
      if (options.signal.aborted) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, options.interval ?? 30_000);
        options.signal.addEventListener('abort', finish, { once: true });
      });
    }
  })();
}
