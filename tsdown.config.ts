import { defineConfig } from 'tsdown'
import ts from 'typescript'

/**
 * Browser half externals: the frozen module table entries the shell shares.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

/**
 * Lower **standard (TC39) decorators** before bundling.
 *
 * `@deepseek-ai/dsh-typert-protocol` 的 `@Remote` 只实现标准装饰器形态
 * （`(method, context)` + `context.addInitializer`）；传统装饰器的调用形状会让它
 * 直接抛错。而装饰器是 stage-3 语法，rolldown/oxc 不会为任何 `target` 降级它 ——
 * 直接打包会把 `@Remote` 原样留在 ES2022 产物里（运行时 SyntaxError）。
 *
 * 官方 `@deepseek-ai/dsh-typert-generator/tsdown` 的 `typertPlugin()` 对
 * TypeScript 依赖做的正是同一件事（`ts.transpileModule` 降级装饰器），这里用同样
 * 的手法处理本包自己的源码。
 */
const lowerDecorators = {
  name: 'dsh:lower-standard-decorators',
  transform(code: string, id: string) {
    if (!/\.tsx?$/.test(id) || id.includes('node_modules')) return undefined
    if (!/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return undefined
    const out = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        // 关键：标准装饰器（保持 false），不能用 legacy 传统装饰器。
        experimentalDecorators: false,
        useDefineForClassFields: true,
      },
    })
    return { code: out.outputText, map: null }
  },
}

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
    // pi-ai / schemastery / cordis / typert-protocol 保持 external：与运行时共享实例。
    external: [/^@earendil-works\//, /^@deepseek-ai\//],
    plugins: [lowerDecorators],
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
