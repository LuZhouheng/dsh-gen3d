# dsh-gen3d — AGENTS.md

DeepSeek Harness（DSH）的 3D 角色生成插件：直连 Meshy / 腾讯混元 3D / Tripo3D / Rodin
四家官方 API，cordis/CLI 原生，无 MCP。

## 构建 / 测试

- `pnpm install` → `pnpm build`（tsc ×2 + tsdown → `lib/`，含浏览器半边 `lib/client.js`）→ `pnpm test`（vitest，全绿才算完）
- 发布：`pnpm publish --access public --no-git-checks`（`prepublishOnly` 自动重跑 build+test）

## 结构与入口

- `src/index.ts` — 装配层（21 个 `gen3d_*` 工具 + 计费审批 gate + 随包 skill 自注册 + 设置卡片 host 半边 + 可选 webServer 路由）
- `src/providers/` — 四家官方 API 直连（meshy 最全）；`src/tools/` 工具实现；`src/render/` 纯 JS 软渲染器；`src/client/` web 视窗 + 设置卡片浏览器半边；`skills/` 随包 agent 技能
- 文档：`docs/dsh-api.md`（DSH 插件 API 精读 + §8 实测记录）、`docs/KNOWN-GAPS.md`（已知缺口逐条：影响 / 规避 / 后续）、`docs/CREDENTIALS.md`（凭证安全）、`docs/providers/`（四家协议）

## 红线（踩过的坑，勿复踩）

- **密钥零内置**：凭证走 `src/config.ts` 四层读取（env > `$DSH_HOME/.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`）；key 绝不进仓库 / 日志 / 输出；docs 里只放 `msy_YOUR_...` 占位符。
- **宿主服务包（`@deepseek-ai/dsh-*`）只进 peerDependencies + devDependencies**——进 dependencies 会被 `dsh plugin add` 装进 profile node_modules，遮蔽宿主单实例形成双实例 Symbol 漂移（agent-loop 调任何工具即炸，见 docs/dsh-api.md §8 条目 6）。
- **计费 POST 提交不做盲重试**（可能重复建单重复计费）；只有幂等 GET（轮询 / 余额 / 下载）有传输重试（`src/providers/meshy.ts` 的 `IDEMPOTENT_RETRY_*`）。
- **分发只走 npm registry 或 `pnpm pack` tarball**；目录 link 安装不会被 pnpm 解析依赖（`ERR_MODULE_NOT_FOUND`）。新版本发布数小时内 bare `dsh plugin add` 可能被 pnpm 发布冷却回落到旧版——显式 `@latest` 或指定版本号。
- 改动涉及 KNOWN-GAPS 登记的行为时，同步更新对应条目（含状态翻转）。
