import { Model, Plugin, Provider } from '@opencode/plugin';
import { createBridge } from './bridge';
import { discoverModels, watchModels, type KiroModel } from './models';

export default Plugin.define({
  id: 'opencode.provider.kiro',
  async setup(ctx) {
    const cli = typeof ctx.options.cli === 'string' ? ctx.options.cli : 'kiro-cli';
    let inventory: KiroModel[] = [];
    const controller = new AbortController();
    let watching: Promise<void> | undefined;
    // Keep authenticated startup deterministic for explicit model selections.
    // A failed check leaves the plugin active; the watcher retries after login.
    try { inventory = await discoverModels(cli, controller.signal); }
    catch (error) { console.warn(String(error)); }
    const bridge = await createBridge(ctx.location.directory, {
      cli, model: typeof ctx.options.model === 'string' ? ctx.options.model : undefined,
    });
    try {
      const id = Provider.ID.make('kiro');
      await ctx.provider.transform(editor => {
        const models = inventory.map(entry => {
          const defaults = Model.Info.default(id, Model.ID.make(entry.model_id));
          return { ...defaults, name: entry.model_name, variants: ['low', 'medium', 'high'].map(effort => ({ id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } })), capabilities: { ...defaults.capabilities, input: ['text', 'image'] }, limit: { ...defaults.limit, context: entry.context_window_tokens || 200_000 } };
        });
        editor.add({
          info: { ...Provider.Info.empty(id), name: 'Kiro CLI', activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: bridge.url, apiKey: bridge.secret } }, models,
        });
      });
      await ctx.session.hook('http.request', async event => {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        event.request.headers.set('x-opencode-session', event.sessionID);
        event.request.headers.set('x-opencode-kind', event.kind);
        event.request.headers.set('x-opencode-directory', session.location.directory);
      }, { providerID: 'kiro' });
      watching = watchModels({
        cli, signal: controller.signal,
        async update(models) { inventory = models; await ctx.provider.reload(); },
        report(message) { console.warn(message); },
      });
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === 'session.execution.interrupted') await bridge.cancel(event.data.sessionID);
          }
        } catch (error) { if (!controller.signal.aborted) console.error('Kiro event subscription failed:', String(error)); }
      })();
      return async () => { controller.abort(); await watching; await bridge.stop(); };
    } catch (error) { controller.abort(); await watching; await bridge.stop(); throw error; }
  },
});
