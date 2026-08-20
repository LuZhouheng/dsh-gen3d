// gen3d 设置卡片 client bundle —— 自复刻官方 clientBundle 预设（tsdown）
// 的输出格式（预设未发布到 npm，见官方 docs/cookbook/adding-a-settings-card.md）：
// lazy-CJS factory 产物（window.__ModuleLoader__.load({id, factory})），externals
// 走 loader 模块表，入口文件名固定 lib/client.js（路由 /plugins/<id>/client.js）。
// externals/define/noExternal/纯度门逐项对齐 packages/client/tsdown.client.ts。

import type { UserConfig } from 'tsdown';

/** rc.8 平台模块表（官方 packages/client/web/src/platform.ts PLATFORM_MODULES）。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
] as const;

/** rc.8 预载 externals（PRELOADED_CLIENT_EXTERNALS：runtime store 引擎）。 */
const PRELOADED_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client'] as const;

/** 从 loader 模块表解析的 externals：平台模块 + 预载项。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, ...PRELOADED_EXTERNALS];

const config: UserConfig = {
  name: 'dsh-gen3d/client',
  entry: { client: 'lib/client/index.js' },
  // 与官方 clientConfig 对齐：CJS + browser；lib/ 与 tsc 产物共存，clean 必须关。
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  // 与官方一致：浏览器 bundle 内联 node-idiom 依赖（zustand/immer 读
  // process.env.NODE_ENV），缺了工厂会在 boot 时 ReferenceError。
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // 模块表之外的任何依赖都必须内联：require 一个表里没有的 specifier 是
  // 必然的运行时抛错，所以规则就是表本身。
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // client bundle 纯度门（官方同名 gate 的自复刻）：平台模块外的一切
    // @deepseek-ai/* 值导入都是构建错误（跨插件值导入要么内联重复实例、
    // 要么 require 冻结模块表没有的 specifier）；type-only 导入已擦除。
    name: 'dsh-gen3d-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null;
      if (CLIENT_EXTERNALS.includes(source)) return null;
      throw new Error(
        `client bundle purity: "${source}" is not a platform module or preloaded external — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services',
      );
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-gen3d", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
};

export default config;
