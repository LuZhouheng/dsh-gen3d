// gen3d 设置卡片 client bundle —— 对齐官方 clientBundle 预设（tsdown）的
// 输出格式（预设未发布到 npm，见官方 docs/cookbook/adding-a-settings-card.md）：
// lazy-CJS factory 产物（window.__ModuleLoader__.load({id, factory})），externals
// 走 loader 模块表，入口文件名固定 lib/client.js（路由 /plugins/<id>/client.js）。
// 模块表白名单逐项对齐 packages/client/tsdown.client.ts 的
// PLATFORM_MODULES / PRELOADED_CLIENT_EXTERNALS（官方预设另含 define 三键，
// 本 bundle 无 zustand/immer 类依赖、不读 process.env，是死配置故不引入）。

import type { UserConfig } from 'tsdown';

/** rc.8 平台模块表（官方 packages/client/web/src/platform.ts PLATFORM_MODULES）。 */
const PLATFORM_MODULES: string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
];

/** rc.8 预载 externals（PRELOADED_CLIENT_EXTERNALS：runtime store 引擎）。 */
const PRELOADED_EXTERNALS: string[] = ['@deepseek-ai/dsh-client-runtime/client'];

/** 从 loader 模块表解析的 externals：平台模块 + 预载项。 */
const CLIENT_EXTERNALS: string[] = [...PLATFORM_MODULES, ...PRELOADED_EXTERNALS];

/** 是否模块表条目（模块表之外的一切依赖都必须内联：require 一个表里没有的
 *  specifier 是必然的运行时抛错，所以规则就是表本身）。 */
function isExternal(id: string): boolean {
  return CLIENT_EXTERNALS.includes(id);
}

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
  deps: {
    // 模块表条目保持 external（loader 的 require 解析）；其余一律内联。
    neverBundle: CLIENT_EXTERNALS,
    alwaysBundle: (id: string) => (isExternal(id) ? undefined : true),
  },
  plugins: [{
    // client bundle 纯度门（官方同名 gate 的收紧版）：官方对 inline-safe 的
    // wire/类型层（dsh-host-apiproxy/session/llm/tools/brand）、vendored
    // 框架库（cosmokit/schemastery）与生成的 /remote 贡献有放行；本面是
    // 只读卡片 + 值导入面极小，除模块表外的一切 @deepseek-ai/* 值导入直接
    // 报错（跨插件值导入要么内联重复实例、要么 require 冻结模块表没有的
    // specifier）；type-only 导入已擦除，不经过本 gate。
    name: 'dsh-gen3d-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null;
      if (isExternal(source)) return null;
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
