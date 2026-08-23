import { defineConfig } from 'tsdown'

/**
 * Browser half externals: the frozen module table entries the shell shares.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

export default defineConfig([
  // ── Node (host) half ────────────────────────────────────────────────────
  {
    name: 'dsh-model-toggles',
    entry: {
      index: 'src/index.ts',
      // 纯逻辑层独立产物：冒烟脚本按文件直测。
      capabilities: 'src/capabilities.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    // pi-ai / schemastery MUST stay external: runtime shares one pi-ai instance.
    external: [/^@earendil-works\//, /^@deepseek-ai\//],
  },
  // ── Browser (client) half ───────────────────────────────────────────────
  {
    name: 'dsh-model-toggles/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
    },
    banner: 'window.__ModuleLoader__.load({ id: "dsh-model-toggles", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
])
