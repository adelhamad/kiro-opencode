export interface KiroModel { model_id: string; model_name: string; context_window_tokens?: number; description?: string }
export async function discoverModels(cli = 'kiro-cli'): Promise<KiroModel[]> {
  const child = Bun.spawn([cli, 'chat', '--list-models', '--format', 'json'], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error('Cannot read Kiro model list. Check kiro-cli login.');
    const data = JSON.parse(output);
    if (!Array.isArray(data.models) || !data.models.length) throw new Error('Kiro returned an empty model list');
    return data.models;
  } finally { clearTimeout(timer); }
}
