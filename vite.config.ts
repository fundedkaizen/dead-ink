import { defineConfig, type Plugin } from 'vite'
import preact from '@preact/preset-vite'
// @ts-expect-error plain JavaScript module, shared with the standalone relay
import { attachRelay } from './server/coop-relay.mjs'

/**
 * The game entry is a tiny bootstrap that import()s the real game so a failed load can show a fallback.
 * Without help the browser only learns about the game chunks after that bootstrap runs, and about the
 * clip chunk after the model has loaded. List them all in index.html so they download with the HTML.
 */
let base = '/'
const preloadGameChunks: Plugin = {
  name: 'preload-game-chunks',
  configResolved(config) { base = config.base },
  transformIndexHtml: {
    order: 'post',
    handler(html, { bundle, filename }) {
      if (!bundle || !filename.endsWith('index.html')) return
      const game = Object.values(bundle).find(chunk => chunk.type === 'chunk' && chunk.facadeModuleId?.endsWith('/src/main.ts'))
      if (!game) throw new Error('preload-game-chunks: src/main.ts chunk not found')
      const files = new Set<string>()
      const visit = (file: string) => {
        const chunk = bundle[file]
        if (files.has(file) || chunk?.type !== 'chunk') return
        files.add(file)
        for (const next of [...chunk.imports, ...chunk.dynamicImports]) visit(next)
      }
      visit(game.fileName)
      // Vite already lists the bootstrap's own static imports.
      return [...files].filter(file => !html.includes(file)).map(file => ({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: base + file }, injectTo: 'head' as const }))
    },
  },
}

/** Dead Ink co-op: the relay rides on the dev server, at /coop. */
const coopRelay: Plugin = {
  name: 'dead-ink-coop-relay',
  configureServer(server) { if (server.httpServer) attachRelay(server.httpServer) },
  configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer) },
}

export default defineConfig({
  plugins: [preact(), preloadGameChunks, coopRelay],
  // A full-page hot reload erases an in-progress game in every connected tab.
  // Pick up source edits on manual refresh, so pausing to use a coding agent is safe.
  server: { hmr: false, allowedHosts: ['.trycloudflare.com'] },
  // A built copy served for co-op through a Cloudflare quick tunnel (a public trycloudflare.com link).
  preview: { allowedHosts: ['.trycloudflare.com'] },
  build: {
    rolldownOptions: {
      input: { main: 'index.html', lab: 'lab.html' },
      output: {
        codeSplitting: {
          groups: [
            // three changes only on upgrade; app code changes every release. Keep their cache lifetimes apart.
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 2 },
            // Clips build from the loaded rest skeleton, so they must stay behind import() and never pull in
            // their shared dependencies (that would make the game chunk import them eagerly). One request instead of six.
            // Only modules that build clips on load: weapons/poses and postures are plain pose maths the game's own code
            // imports (Dead Ink's co-op partner poses use heldPose), and grouping them here made the game import this
            // chunk at startup, before loadStickman(), so the built game failed to load.
            { name: 'clips', test: /src[\\/]lab[\\/](clips[\\/]|death-settle)/, priority: 1, includeDependenciesRecursively: false },
          ],
        },
      },
    },
  },
})
