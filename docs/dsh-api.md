# DSH（DeepSeek Harness）插件开发 API 精读

> 面向 dsh-gen3d 迁移的权威参考。所有源码引用以本机浅克隆的 DSH 官方源码仓库
> （下文记作 `<repo>`）为准，标注格式为 `路径:行号`。实测验证基于本机 npm
> 全局 `dsh@0.1.0-rc.6` 与 registry 上的 `@deepseek-ai/dsh-tools@0.1.0-rc.6`
> （见第 8 节）。
>
> 2026-08-20 追加：本机 npm 全局 `dsh@0.1.0-rc.8`，registry 上
> `@deepseek-ai/dsh-tools / dsh-jobs / dsh-skill` 同为 `0.1.0-rc.8`，插件面 API
> 无 breaking change；rc.6 实测记录保留为历史，见第 8 节新增条目 5。
>
> 2026-08-24 追加：本机 npm 全局 `dsh@0.1.1-rc.2`。官方 changelog（rc.8 →
> 0.1.1-rc.2）仅含 DeepSeek 适配器改动（图片改走 Files API、新增视觉模型
> `DeepSeek-V4-Flash-Vision-Exp`、图片预处理自动缩放）与 UI / 沙箱修复，
> **插件面 API 无 breaking change**。**registry 陷阱**：`@deepseek-ai/*` 子包的
> `latest` dist-tag 错指 `0.0.1-rc.3`，真实最新挂在 `next` 标签——升级依赖必须
> 显式钉版本号，不可用 `@latest`。四宿主服务依赖已按 rc.2 对齐：
> `dsh-jobs / dsh-settings / dsh-skill / dsh-tools` 改走 peerDependencies
> （`^0.1.0-rc.8`）+ devDependencies 钉 `0.1.1-rc.2`（同 host 闭包），
> `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已并入 rc.2 条目
> （过程与修复后无头 E2E 证据见第 8 节条目 6）。

---

## 1. 插件包格式：bundle 与 profile

### 1.1 两个概念

DSH 的安装体系基于两个概念，都写在 `package.json` 的 `dsh` 键下，但互不相同：

| 概念 | 是什么 | 清单字段 | 回答的问题 |
|---|---|---|---|
| **bundle** | 一个 npm 包，携带一层配置 | `dsh.bundle` | "这个包贡献了什么"：一个 patch 文件，插入或覆盖插件行 |
| **profile** | `$DSH_HOME/profiles/<name>/` 下的一个可运行组合目录 | `dsh.profile` | "哪些 bundle 以什么顺序组成这个 setup" |

- 来源：`<repo>/docs/user/develop/basic/publish.md:9-16`
- bundle 是你要编写和分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。一个包不可能同时是两者（`publish.md:16`）。
- 运行时 `dsh` 是一个插件树：每个部分都是插件（模型适配器、工具注册表、会话日志、agent 循环），注册是"效果"（effect），插件卸载时自动撤销（`<repo>/docs/architecture.md:9-13`）。

### 1.2 bundle 的 package.json（`dsh` 元数据字段）

官方最小样例（`publish.md:33-44`）：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `dsh.bundle.patch`：指向本包的 patch 文件（相对路径）。仓库内真实 bundle 完全一致：`<repo>/packages/bundle/base/package.json:36`（`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）。
- 架构文档总述：`dsh.profile` 列出 profile 的 bundles，`dsh.bundle` 指向 bundle 的 patch 文件（`<repo>/docs/architecture.md:23`）。
- **没有 `dsh.bundle` 声明的包也能安装，但只作为普通依赖**：`dsh plugin` 会打印警告且不激活任何层（`publish.md:64`）。这种格式留给"被插件包 import 的库"。
- 分层：`dsh-base` 是每个 profile 的第一层（模型适配器、工具、持久化、沙盒与审批策略、设置、凭证、遥测）；`dsh-web-app` 加浏览器应用；`dsh-headless` 加无服务器的单次运行器（`architecture.md:25`）。

### 1.3 cordis.patch.yml 语法

patch 是一个 YAML **数组**（与 `--patch` 覆盖层同方言），元素是"补丁指令"：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

- 行（row）字段与 loader 的 `EntryOptions` 一一对应（`<repo>/vendor/loader/src/config/entry.ts:9-20`）：

```ts
export interface EntryOptions {
  id: string        // 条目树内的稳定 id
  name: string      // 模块说明符：插件包名或源码路径
  config?: any      // 传给插件的配置
  group?: boolean   // 嵌套 group 标记
  disabled?: boolean | null  // 阻止该行及其后代运行
  inject?: Inject   // 该行需要的服务（服务注入声明）
}
```

- `insert` 的每个子项都是上面的行。**按 id 覆盖**的写法是直接给出行字段（无 `insert` 包裹），例如 `dsh-web-app` 覆盖 base 的 `tools` 行（`<repo>/packages/bundle/web-app/cordis.patch.yml:35-41`）：

```yaml
- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE
```

- **`!!js` 表达式**：patch 里任意标量值可用 `!!js <expr>` 写 JS 表达式，在行激活时求值（`vendor/include/src/index.ts:9-21` 定义 YAML tag，`vendor/loader/src/config/utils.ts:5-9` 求值实现）：

```js
// new Function('ctx', 'expr', `with (ctx) { return eval(expr) }`)
```

  求值作用域是该行的 Cordis context，因此可用：`process.env.X`（`web-app/cordis.patch.yml:41`）、`dshHomePath('sessions')`（`<repo>/packages/bundle/base/cordis.patch.yml:101`，`dshHomePath` 由 app-boot 提供在 ctx 上：`<repo>/packages/boot/app-boot/src/index.ts:770`）、以及行内 `inject` 注入的服务（`publish.md:141-151`：Loader 先等行内注入就绪，再用注入后的 ctx 求值 `!!js` config）。
- **行内注入**示例（`publish.md:134-149`）：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

- `disabled` 也可用 `!!js`（`web-app/cordis.patch.yml`、`base/cordis.patch.yml:210-212`：`disabled: !!js process.platform === 'win32'`）。

### 1.4 层顺序与覆盖语义（bundle 作者必读）

生效配置按以下顺序叠加在空根上（`publish.md:114-119`）：

1. profile 的 `dsh.profile.bundles` 列表中的每个 bundle patch，按列表顺序（`dsh-base` 第一个）；
2. profile 自己的 `cordis.patch.yml`；
3. 机器级 `$DSH_HOME/cordis.patch.yml`；
4. 每个 `--patch <path>` 覆盖层，按 argv 顺序。

语义要点（`publish.md:123-128`）：

- **后层按行 id 整行取胜，且 patch 替换整行 `config`，不深合并**。因此你的 bundle 可以按 id 覆盖更早层的行，但必须重写该行需要的每个键；
- 用户可以在自己 profile 的 patch 里覆盖你的行（推荐把默认值设成用户大概率会保留的）；
- 盒内 bundle 名（`@deepseek-ai/dsh-base` 等）总是从 dsh 安装本身解析，pnpm 只管 out-of-tree 包。

### 1.5 安装与分发

```sh
dsh plugin --profile demo add ./hello-plugin      # 本地目录（link 安装）
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz   # tarball（推荐，见第 8 节第 3 条）
dsh plugin --profile demo add github:you/hello-plugin    # git 安装
dsh plugin --profile demo remove dsh-hello-plugin
```

- `dsh plugin --profile <name> <args...>` 转发到 pnpm（`publish.md:77`）；首次使用初始化 profile（第一个 bundle 是 `@deepseek-ai/dsh-base`），并把带 `dsh.bundle` 的包追加进 `dsh.profile.bundles`（`publish.md:83-101`）。
- 验证层：`dsh --profile demo --dump-config`（会打印 `# == dsh-hello-plugin` 标记层）。
- **git 安装陷阱**：git 安装取的是源码而非构建产物，不跑 `build` 脚本；TypeScript 包必须提供自包含的 `prepare` 脚本构建 `lib/`（`publish.md:161-163`）；且 pnpm ≥10 首次拒绝运行 git 依赖的 `prepare`，需要在 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds`（`publish.md:164-173`）。**发布 npm / 发 tarball 则无需任何构建许可**（`publish.md:175-178`）。

---

## 2. defineTool：完整签名与 schema DSL

### 2.1 定义位置与整体签名

- 实现：`<repo>/packages/core/tools/src/schema.ts:545-617`（`defineTool`）；选项类型 `DefineToolOptions` 在 `schema.ts:482-536`。
- 从 `@deepseek-ai/dsh-tools` 根导出（`<repo>/packages/core/tools/src/index.ts:65-75`）。

```ts
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition
```

`DefineToolOptions` 字段（`schema.ts:483-536`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | ✅ | 工具名，必须唯一 |
| `description` | `string` | ✅ | 模型可见的人类可读描述 |
| `parameters` | `S extends ParameterSchemaSpec` | ✅ | 逐属性参数 schema，编译为隐式开放对象根 |
| `output` | `{ schema: O; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }` | ✅ | 规范输出：schema 强校验每个成功值；`render` 是纯函数投影为模型内容；`presentationMeta` 导出可重放的持久化卡片元数据 |
| `timeoutMs?` | `number` | | 正有限数；合作式超时预算，**绝不发给模型** |
| `isConcurrencySafe?(args)` | `(args: InferArgs<S>) => boolean` | | 纯同步分类器，精确 `true` 才允许与兄弟调用重叠 |
| `execute(args, exec)` | `(args: InferArgs<S>, exec: ToolRunContext) => Promise<InferValue<NoInfer<O>>>` | ✅ | 参数校验后执行；只返回 output.schema 声明的规范 JSON 值 |
| `finalizeContent?(exec, result)` | `(exec, result) => ContentBlock[] \| undefined` | | 每次归一化结果恰好执行一次的同步最后一英里内容变换 |
| `presentCall?(args)` | `(args) => ToolCallView \| undefined` | | 纯函数，UI 的 pending 卡片 |
| `presentResult?(args, result)` | `(args, result) => ToolResultView \| undefined` | | 纯函数，UI 的完成卡片 |

`ToolDefinition`（原始注册契约）见 `<repo>/packages/core/tools/src/index.ts:222-288`；`ToolOutputDefinition`（`output` 的类型）见 `index.ts:211-219`。

### 2.2 参数 schema DSL（`ValueSchemaSpec` / `ParameterSchemaSpec`）

统一 DSL 定义在 `<repo>/packages/core/tools/src/schema.ts`：

- `ValueSchemaSpec` 联合类型：`schema.ts:85-94`。支持 9 种节点：

| 节点 | 接口（行号） | 额外字段 |
|---|---|---|
| `string` | `schema.ts:24-28` | `enum?: readonly string[]`、`const?: string` |
| `number` | `schema.ts:31-35` | `enum?: readonly number[]`、`const?: number`（有限 JSON 数） |
| `integer` | `schema.ts:38-42` | `enum?: readonly number[]`、`const?: number` |
| `boolean` | `schema.ts:45-49` | `enum?: readonly boolean[]`、`const?: boolean` |
| `null` | `schema.ts:52-56` | `enum?: readonly null[]`、`const?: null` |
| `array` | `schema.ts:59-62` | `items?: ValueSchemaSpec`（省略则接受任意 lossless JSON 项） |
| `object` | `schema.ts:68-72` | `properties?: ParameterSchemaSpec`、**`additionalProperties: boolean`（必填，显式开放）** |
| `json` | `schema.ts:75-77` | 无（作者专用：不受限的 lossless JSON 节点） |
| `oneOf` | `schema.ts:80-82` | `oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]`（精确一选一，至少两支） |

- 所有节点共享注解 `description?`、`title?`、`default?`（非校验注解）、`examples?`（`schema.ts:12-21`）。
- **`ParameterSchemaSpec`**：`{ [key: string]: ParameterPropertySpec }`，即隐式开放对象根的逐属性映射；必填是逐属性的 `required?: true`（`schema.ts:97-106`）。
- 类型推导：`InferValue<S>` / `InferArgs<S>`（`schema.ts:172-175`）；精确推导到 16 层容器深度，之后回退 `JsonValue`（`schema.ts:153-166`）。
- **开放/封闭规则**（`<repo>/packages/core/tools/README.md:93-95`）：隐式参数根开放；显式 object 必须声明 `additionalProperties`，`true` 收额外键、`false` 不收（无属性的封闭对象只接受 `{}`）；raw JSON Schema 对象默认开放除非显式 `additionalProperties: false`。默认值不自动应用；省略 `properties` 的开放对象和省略 `items` 的数组只做容器类型检查。
- `enum`/`const` 是类型正确的字面量约束（`schema.ts:24-56`）；非法枚举成员、缺失必填、类型错误、嵌套违规在 `execute` 前抛 `ToolArgsError`（code `INVALID_ARGS`）（`schema.ts:460-470`、`README.md:95`）。
- 编译辅助：`parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` / `validateArgs`（`schema.ts:438-480`）。

**每种类型的写法示例**（对象字段型参数最常用）：

```ts
parameters: {
  prompt: { type: 'string', required: true, description: '文生3D提示词' },
  seed: { type: 'integer', description: '随机种子' },
  quality: { type: 'string', enum: ['draft', 'preview', 'final'], description: '质量档' },
  tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
  options: { type: 'object', additionalProperties: true, description: '额外选项' },
  mode: { oneOf: [
    { type: 'string', const: 'text-to-3d' },
    { type: 'object', additionalProperties: true, properties: { imageUrl: { type: 'string', required: true } } },
  ] },
}
```

### 2.3 execute(args, exec)：`exec` 的成员

`execute` 收到类型化 `args` 和 `ToolRunContext`（`<repo>/packages/core/tools/src/index.ts:404-421`），后者继承 `ToolExecution`（`index.ts:379-384`），`ToolExecution` 继承 `ToolExecutionInput`（`index.ts:314-338`）：

| 成员 | 类型 | 说明 |
|---|---|---|
| `token` | `ToolExecutionToken`（branded symbol） | 注册表分配的不可变调用身份，仅用于相等关联，绝不跨模型/日志/worker 边界 |
| `callId` | `CallId` | 调用 id |
| `rootCallId` | `CallId` | 根调用 id（嵌套执行已解析） |
| `name` | `string` | 工具名 |
| `arguments` | `unknown`（已深冻结） | 无损 JSON 快照后的参数，视为只读输入 |
| `agent?` | `Agent` | 代表其运行的 agent（agent loop 设置） |
| `parent?` | `ToolExecutionToken` | 外层传输执行的 opaque 令牌（Code Mode 子分发） |
| `signal` | `AbortSignal` | **必填的调用方取消信号，只读**——所有异步工作必须观察或转发它，工作停止后才 settle |
| `deferContext(context: UserMessage)` | 方法 | 把一条上下文推迟到本工具最终结果到达 loop 之后（复合工具搬运嵌套上下文） |
| `concludeTurn()` | 方法 | 把成功最终结果标记为当前 agent turn 终止（`index.ts:420`） |

- `ToolRunContext.signal` 是工具体唯一合法的信号来源（`README.md:35`：取消是合作式、安静的；注册表在工具体调用前重新融合原始调用方信号）。
- 执行契约规则（`<repo>/docs/cookbook/adding-a-tool.md:40-49`）：只返回规范 JSON 值；抛错或返回非法值 → `isError`；不要从 body 返回内容块；基础设施失败才 throw，业务失败用规范值表达（如非零退出码）。
- 类型推导结果示例（`README.md:67-91`、`adding-a-tool.md:9-36`）。

### 2.4 output：schema / render / presentationMeta

- `output.schema`（`ValueSchemaSpec`）对每个成功的规范值强校验，快照为 lossless JSON、冻结后传给 `output.render(args, value)`（`README.md:43-48`、`adding-a-tool.md:45`）。
- `render` 返回 `ContentBlock[]`（模型看到的 Native 内容），必须是纯函数。
- `presentationMeta(args, value)` 派生可重放的 JSON，随 `tool/result` 持久化并回传给 `presentResult`（`adding-a-tool.md:48`、`README.md:114`）；嵌套 Code 分发不计算元数据。
- **不要**从 `render` 或规范值里输出仅供 UI 的格式（diff、相对路径、` ```console ` 围栏）——UI 态归 `presentationMeta` + 卡片投影器（`adding-a-tool.md:86-87`）。

### 2.5 工具卡片：presentCall / presentResult

- 类型：`ToolCallView`（`<repo>/packages/core/tools/src/presentation.ts:46`）、`ToolResultView`（`presentation.ts:140`）。
- **调用卡片（pending）**：
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }`（`presentation.ts:53-75`）——默认；`kind` 是图标类别；`locations: [{ path, line? }]` 供编辑器跟随；
  - `{ card: 'terminal', title, description?, cwd? }`（`presentation.ts:84-100`）——调用本身就是 shell 命令；
  - `{ card: 'diff', title, diffs, locations? }`（`presentation.ts:110-118`）——创建/修改文件；`diffs: [{ path, oldText, newText }]`，新建文件 `oldText: null`。
- **结果卡片（completed）**（`adding-a-tool.md:77-82`）：
  - `generic`（可选 title/content）、`terminal`（raw output + 可选退出码）、`diff`（应用后的 hunk，常由 `presentationMeta` 派生）、`search`（`shape: 'matches'` 分组匹配 / `shape: 'paths'` 平铺路径 + `truncated`/`total`，无调用期类比）、`read`（带行号的代码视图：`path, offset, lines: {number, text}[], totalLines, lang?, content?`）、`web`（`kind: 'search' | 'fetch'`）。
- 硬规则（`adding-a-tool.md:84-88`）：**纯函数**——可能在直播流和会话日志重放上运行，禁 I/O、禁读会话状态、禁时钟/随机；返回 `undefined` 走通用回退；`defineTool` 对展示路径做软校验（旧日志参数畸形时回退通用卡片而非抛错）。`ToolResult` 输入形状 `{ content, isError, meta? }`（`index.ts:291-302`）。

---

## 3. 审批：tools/pre-execute 返回 ask + ctx.approval

### 3.1 PreToolDecision

```ts
// <repo>/packages/core/tools/src/index.ts:588-591
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

### 3.2 tools/pre-execute waterfall（返回 ask 的写法）

事件声明：`<repo>/packages/core/tools/src/index.ts:142-152`。waterfall 语义：监听器返回自己的决策或调 `next()` 委托给后面的监听器；`next()` 缺省即 allow；**ask 在审批服务缺失时降级为 deny**。

官方 permission-gate 示例（`<repo>/docs/cookbook/extension-cookbook.md:13-34`）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

- 该 waterfall 是**可重排**的策略层（`README.md:57`）；需要不可撤销的单调最终拒绝用 `ctx.tools.guard()`（`README.md:25`）。
- 作用域过滤（`@deepseek-ai/dsh-scope`）：agent 级监听器只收到该 agent 的调用（`index.ts:148`）。
- 监听器必须是异步 gate 并观察 `exec.signal`；注册表在它们 settle 后重查取消（`index.ts:146-147`）。

### 3.3 ask 的服务流程

`ask` 决策由注册表内部 `serviceAsk` 处理（`<repo>/packages/core/tools/src/index.ts:1678-1729`）：

1. `const approval = this.ctx.get('approval')`——**机会式消费，不静态注入**；部署没装 ApprovalService 时 ask 直接降级 deny（`index.ts:1693-1699`、`README.md:31`）；
2. 无 `exec.agent` 的调用也 deny（`index.ts:1700-1705`）；
3. `approval.request({ agent, toolName, callId, ...(reason ? { reason } : {}), signal })`（`index.ts:1706-1712`）；
4. 结果一对一映射（`index.ts:1713-1728`）：`allowed-once` → allow；`rejected` / `cancelled` / `unavailable` → deny（带不同 reason，模型可区分"用户拒绝"与"无审批通道"）。

审批服务契约（`<repo>/packages/interaction/user-approval/README.md:5-13`、`<repo>/docs/subsystems/approval.md:86-118`）：

- `ctx.approval.request(req)` 返回 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`approval.md:28`）；缺失/失败 answerer 一律 fail-closed 为 `unavailable`；
- 请求必须属于一个开放的 agent turn；服务追加成对的 `approval/asked` + `approval/decided` 审计记录（仅日志，模型只看到消费方的结果）；
- `ApprovalRequest`：`{ agent, toolName, callId?, reason? }`——**刻意不带工具参数**（`approval.md:60-74`）；
- 策略 `ApprovalPolicy = 'ask' | 'never'`（`approval.md:33-46`）：`never` 在分发前确定性拒绝；有效值是会话日志中最后一条 `approval/policy` 事件，回退到服务配置；`setApprovalPolicy()` 是唯一写路径。

### 3.4 在工具体内直接请求审批（参考 tool-bash）

tool-bash 沙盒升级在 execute 前通过 `ctx.get('approval')` 请求（`<repo>/packages/shell/tool-bash/src/index.ts:203-234`）：

```ts
const approval = ctx.get('approval')
// 组装 { approver, agent: exec.agent, callId: exec.callId, toolName: 'bash', signal: exec.signal }
```

### 3.5 部署侧配置

dsh-base 的审批行（`<repo>/packages/bundle/base/cordis.patch.yml:188-191`）：

```yaml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
```

即默认组合自带 `dsh-user-approval` 且 policy 为 `ask`；headless/未组合完整部署解析为 `unavailable` 并 fail-closed（`user-approval/README.md:61`）。

**dsh-gen3d 用法**：注册一个 `tools/pre-execute` 监听器，对 `gen3d_*` 计费工具（文生3D/图生3D/精修等）返回 `{ kind: 'ask', reason: 'gen3d API 调用将消耗配额…' }`，其余 `return next()`。

---

## 4. ctx.credentials：按引用解析用户密钥

### 4.1 原则（三个信条）

- **配置只携带引用，绝不携带密钥**：settings 或 cordis 配置写 `apiKeyEnv: MESHY_API_KEY` 这样的引用，值由凭证 provider 持有（`<repo>/packages/credentials/credentials/README.md:7`）；
- **消费者每次操作时解析**：`resolve(ref)` 在每次操作开始时调用（LLM 适配器每模型请求解析一次），从不跨操作缓存——轮换的密钥无需重启即生效（`credentials/README.md:9`）；
- **空存储值即缺席**：`resolve` 跳过、`describe` 报告未配置（`credentials/README.md:11`）。

### 4.2 接口

```ts
// <repo>/packages/credentials/credentials/README.md:15-26
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

declare const ctx: Context

const ref = credentialRef('MESHY_API_KEY')        // POSIX shell 标识符，branded 类型
const hit = await ctx.credentials.resolve(ref)    // { value, source } | undefined
const info = await ctx.credentials.describe(ref)  // { configured, source?, writable } —— 永不含值
await ctx.credentials.set(ref, 'sk-…')            // 只读源遮蔽该 ref 时拒绝
await ctx.credentials.unset(ref)                  // 缺席时 no-op；同遮蔽规则
```

- 子系统参考（`<repo>/docs/subsystems/credentials.md`）：`CredentialRef`（`:11-15`）、`ResolvedCredential`（`:20-27`，含 provider 层 id：`env`/`file`/`project-env`/`user-env`）、`CredentialInfo`（`:34-38`）、抽象方法 `resolve/describe/set/unset`（`:75-101`）、事件 `credentials/updated(ref)`（`:114-129`）。
- 遮蔽规则：只读源（进程环境）当前供应某 ref 时，`set`/`unset` 显式拒绝而不是假装成功（`credentials/README.md:24-30`）。

### 4.3 credentials-local：四层优先级

`dsh-credentials-local`（`<repo>/packages/credentials/credentials-local/README.md:7-16`）：

| 层 | source id | 可写 | 胜出 |
|---|---|---|---|
| 继承的进程环境 | `env` | 否 | **总是** |
| `$DSH_HOME/.credentials.yaml` 文档 | `file` | 是（`set`/`unset`） | 胜过两个 `.env` 层 |
| `<invocation cwd>/.env` | `project-env` | 此处不可写 | 胜过用户 `.env` |
| `$DSH_HOME/.env` | `user-env` | 此处不可写 | 否则 |

- 文档格式：仅一个 YAML 映射（`MESHY_API_KEY: sk-…`），无版本字段无包裹层；目录 `0700`、文档 `0600`；任何偏离（非映射根、非 POSIX 标识符键、非字符串值、空串、重复键、坏 YAML）都失败并响亮报错（`credentials-local/README.md:31-46`）。
- ⚠ rc.2 起对齐：本机 `dsh@0.1.1-rc.2` 部署侧的 `credentials-local` **文档已是版本化格式（`version: 1` + `refs:` 包裹）**，与上条 `<repo>` 快照描述不同；dsh-gen3d 的自实现解析器（`src/config.ts`）**不读 `refs:` 下的键**（需迁移到 §4.4 的 `ctx.credentials.resolve(credentialRef(...))` 才能复用 host 通道）——插件 key 的推荐配置见 `docs/CREDENTIALS.md`（§3.1 警示、§3.2/§3.3）。
- 安全边界：文档同 OS 用户可读（工具进程以同用户运行）——"模型不可读"不是文件权限能保证的；DSH 能做到的是不给模型文档路径、不把值装入进程环境（`credentials-local/README.md:52-56`）。

### 4.4 dsh-gen3d 推荐代码写法

```ts
// src/credentials.ts —— 每次操作开始时解析，绝不缓存
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export interface ProviderKeys {
  meshy?: string
  hunyuan3d?: string
}

export async function resolveKeys(ctx: Context): Promise<ProviderKeys> {
  const [meshy, hunyuan3d] = await Promise.all([
    ctx.credentials.resolve(credentialRef('MESHY_API_KEY')),
    ctx.credentials.resolve(credentialRef('HUNYUAN3D_API_KEY')),
  ])
  return {
    meshy: meshy?.value,
    hunyuan3d: hunyuan3d?.value,
  }
}
```

插件声明 `export const inject = ['credentials']`（等待服务就绪；`<repo>/docs/user/develop/basic/index.md:87-103`）。未配置（`resolve` 返回 `undefined`）时沿袭原设计回退确定性 mock，并在工具结果里显式标注 `configured: false`。

---

## 5. ctx.jobs：长任务

### 5.1 服务契约

`<repo>/packages/jobs/jobs/README.md:9-24`（`JobRegistry`，ctx key `jobs`）：

- `start(spec): JobId`——先校验控制器、spec、精确的活 owner、可选正数 `outputLimitBytes` 与准入策略，然后调用 producer 的 `run()` 一次；预检失败不留任何注册；
- `get(id, caller?)` / `list(caller?)`——非消费快照；列表只含 caller 拥有 + 无主任务；
- `read(id, caller?)`——流任务消费单游标；终态输出任务幂等读取；
- `kill(id, caller?, reason?)`——先调 producer 取消再改状态；取消抛错则任务继续运行；
- `wait(id, timeoutMs, caller?, signal?)`——返回终态快照或超时时的活快照；中止只停等待；
- `onJobDone(listener)` / `onJobsChanged(listener)`——观察者；异常被隔离，不等待。

实现类在 `dsh-jobs-local`（`<repo>/packages/jobs/jobs-local/README.md:5-21`）：每 kind 发 `<kind>-N` id；`maxConcurrentJobsPerOwner` 默认 10；owner 销毁取消并等待其任务。

### 5.2 类型（JobStart / JobHooks / JobKindMap）

`<repo>/packages/jobs/jobs/src/types.ts`：

- `JobStart`（`:46-69`）：`{ kind: JobKind; label: string; outputLimitBytes?: number; owner?: Agent; run(): JobHooks }`——`kind` 也是 id 前缀；`owner` 缺席 = 无主任务，任何 caller 可访问直到服务销毁；`run()` 同步返回 hooks，抛错则什么都不注册。
- `JobHooks`（`:72-91`）：`cancel(reason?)` 必须同步、幂等、最终 settle `done`；`done: Promise<JobOutcome>` 在资源释放后 resolve（不可 reject，reject 转 `failed`）；`readOutput?(): string` 消费式读输出（缺席 = 仅终态输出任务，每任务一个游标）。
- `JobOutcome`（`:32-39`）：`{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }`。
- `JobKindMap`（`:23-26`）：内置 `bash`/`subagent`；**插件用声明合并扩展**：

```ts
// JobKindMap 等类型从包根导出（<repo>/packages/jobs/jobs/src/index.ts:12-24），
// 声明合并必须挂在包根模块名上（无 ./types 子路径导出）：
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    gen3d: 'gen3d'
  }
}
```

### 5.3 工具内集成模式

`<repo>/docs/cookbook/adding-a-tool.md:51-55`：

```ts
const jobId = ctx.jobs.start({          // 返回 JobId（branded string，如 'gen3d-1'）
  kind: 'gen3d',
  label: `gen3d refine ${refineTask.name}`,
  owner: exec.agent,
  run: () => ({
    cancel: (reason) => provider.abort(reason),
    done: provider.finished,       // Promise<JobOutcome>
    readOutput: () => provider.drainOutput(),
  }),
})
// 后台分支返回类型化规范句柄，如 { kind: 'background', jobId }
```

要点：后台分支返回结构化句柄（Code Mode 绝不解析 prose 里的 id）；注册表拒绝预中止的调用；`run()` 开始前运行时校验 owner 与控制器可用性；工具面控制工具 `job_kill`/`job_list`/`job_output` 由 `dsh-tool-jobs` 提供（`capability-seams.md:459`）。

### 5.4 取消语义（重要）

- 前台工作跟随 `exec.signal`；
- **发布后的任务改用任务级取消信号**：外层调用稍后取消只停止等待，不杀死已发布的工作；`job_kill`、owner 销毁、服务 teardown 拥有任务生命周期（`adding-a-tool.md:55`）。

---

## 6. skill 目录格式与发现路径

### 6.1 两种形态与 frontmatter

`<repo>/packages/skill/skill-filesystem/README.md:53-59`：

- 目录包：`<root>/<name>/SKILL.md`；扁平：`<root>/<name>.md`；**只发现一层**（排除嵌套 `**/SKILL.md`）。
- 名字必须 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`，`<repo>/docs/subsystems/skills.md:85`）。
- frontmatter（开放 YAML）：必填 `name`、`description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`（true = 移出模型目录/加载器）、`user-invocable`（false = 移出人类命令）。布尔接受 `true/false/yes/no/on/off/1/0` 大小写不敏感；非法值整条 skill 从发现中丢弃并告警（fail-closed）。
- 目录/正文生命周期分离：发现只解析 frontmatter 出摘要；每次 `skill(name)` 加载重新读文件，正文编辑无需失效协议（`README.md:59`）。

### 6.2 发现根（排名表）

`<repo>/packages/skill/skill-filesystem/README.md:31-41`（`docs/subsystems/skills.md:73-77` 同）：

| 排名 | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir`（配置时） |

- projectRoot = 最近的含 `.git` 祖先，无则 cwd。
- 配套包分工：`dsh-skill` = 注册表（`ctx.skills`）；`dsh-skill-filesystem` = 本 provider；`dsh-tool-skill` = 模型面目录/加载工具；`dsh-skill-badge` = 打包资产目录的 `bundled` 候选（默认禁用，显式开启）（`README.md:7`、`skills.md:79`）。

### 6.3 随包分发（dsh-gen3d 的 skill 目录）

两条官方路径：

1. **环境变量 / 配置字段**：`dsh-skill-filesystem` 的 `bundledSkillDir` 配置（默认 `$DSH_BUNDLED_SKILL_DIR`；仅在 `includeDefaultRoots` 时生效，否则不挂任何 bundled 根）——需要用户在部署侧配置，不"自动随包"（`<repo>/packages/skill/skill-filesystem/src/index.ts:72,172`）。
2. **自注册 provider（推荐，自动随包）**：官方 `dsh-skill-badge` 展示的完整模式——插件模块内 `import.meta.url` 合法，直接在 `apply` 里把包内 skill 目录注册进 `ctx.skills`（`<repo>/packages/skill/skill-badge/src/index.ts:17-60`）：

```ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const SKILL_BODY_URL = new URL('../skills/generate-3d-character/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/generate-3d-character/', import.meta.url)),
} as const

const provider: SkillProvider = {
  name: 'gen3d',
  list: () => Promise.resolve([/* 每个候选一个 SkillCandidate：
    { name, description, invocation: { modelInvocable, userInvocable },
      provider: 'gen3d', source: 'bundled', resourceBase, rank: BUNDLED_SKILL_RANK, locator } */]),
  async get(_candidate): Promise<SkillDefinition> {
    return { /* name/description/invocation/provider/source/resourceBase +
      content: await readFile(SKILL_BODY_URL, 'utf8') */ }
  },
}

export const inject = ['skills']
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
```

- `ctx.skills` 是注册表 seam（`<repo>/packages/skill/skill/README.md`、`capability-seams.md:441`）；`registerProvider` 的注册是效果，插件卸载自动撤销。
- 随包技能文件名必须 kebab-case（如 `generate-3d-character`），frontmatter 必填 `name`/`description`。

---

## 7. 最小完整可运行示例（host 插件）

> 下方三文件即完整内容。第 8 节记录了本机实测（等价 JS 版）的安装与启动结果。
> TS 版与实测 JS 版差异仅在类型注解；若走 git 安装需按 `publish.md:161-173` 补 `prepare` 构建。

### 7.1 index.ts

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-gen3d'
export const inject = ['tools', 'credentials']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'gen3d_ping',
    description: 'Ping a 3D provider and report whether its API key is configured.',
    parameters: {
      provider: {
        type: 'string',
        enum: ['meshy', 'hunyuan3d'],
        required: true,
        description: 'Provider to ping',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const hit = await ctx.credentials.resolve(credentialRef('MESHY_API_KEY'))
      return {
        provider: args.provider,
        configured: hit !== undefined,
        source: hit?.source ?? null,
        aborted: exec.signal.aborted,
      }
    },
  }))

  // 计费类操作：pre-execute ask 审批（审批服务缺席时自动降级 deny）
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name.startsWith('gen3d_')) {
      return { kind: 'ask', reason: 'gen3d API 调用将消耗配额，请确认后继续。' }
    }
    return next()
  })
}
```

（`credentialRef` 从 `@deepseek-ai/dsh-credentials` 导入，`defineTool` 从 `@deepseek-ai/dsh-tools` 导入，二者是不同包，见第 4 节。）

### 7.2 package.json

```json
{
  "name": "dsh-gen3d",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml", "skills"],
  "dependencies": {
    "@deepseek-ai/dsh-tools": "0.1.0-rc.6",
    "@deepseek-ai/dsh-credentials": "0.1.0-rc.6"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

（`dsh.bundle.patch` 指向 patch；`skills` 目录随包分发见第 6.3 节。依赖版本以宿主 dsh 版本为准，发布前与 `dsh --version` 核对。）

### 7.3 cordis.patch.yml

```yaml
- insert:
    - id: gen3d
      name: dsh-gen3d
```

（如需覆盖 base 行按第 1.3 节直接给 `- id: <行id>` 字段；如需给工具行配 config，见 `config.md:34-43` 的 `config:` 键写法。）

### 7.4 安装验证

```sh
cd <dsh-gen3d 仓库目录>
npm pack          # 或 pnpm pack，产出 dsh-gen3d-0.1.0.tgz
dsh plugin --profile demo add ./dsh-gen3d-0.1.0.tgz
dsh --profile demo --dump-config   # 应出现 "# == dsh-gen3d" 层
dsh --profile demo
```

---

## 8. 实测记录（本机 dsh@0.1.0-rc.6）

本机 npm 全局 `dsh@0.1.0-rc.6`，`~/.dsh` 已初始化，registry 上有 `@deepseek-ai/dsh-tools@0.1.0-rc.6`（与宿主同版本）。测试 profile 已清理。

1. **hello-plugin（无依赖）**：按 `publish.md:33-62` 原样三文件（JS 版），`dsh plugin --profile dsh-api-verify add ./hello-plugin` 成功；`--dump-config` 出现 `# == dsh-hello-plugin` 层（行 314-316）；`dsh --profile dsh-api-verify` 启动并打印 `[hello-plugin] plugin loaded!`。
2. **tool-demo（defineTool + credentials + pre-execute ask gate）**：index.js 注册 `gen3d_ping`（`enum` 参数 + object output + `ctx.credentials.resolve(credentialRef('MESHY_API_KEY'))`）+ `tools/pre-execute` ask gate；启动日志 `[tool-demo] registered gen3d_ping + pre-execute ask gate`——注册、服务注入（`inject: ['tools','credentials']`）、事件挂载全部通过。
3. **陷阱（link 安装不解析依赖）**：`dsh plugin add ./目录`（pnpm `link:` 安装）时，插件包自身的 `dependencies` **不会**被 pnpm 解析安装，ESM import `@deepseek-ai/dsh-tools` 报 `ERR_MODULE_NOT_FOUND`；先 `npm pack` 再 `dsh plugin add ./xxx.tgz` 则依赖正确 hoist 到 profile `node_modules`（实测通过）。**分发必须用 tarball 或 registry，不要用目录链接。**（2026-08-14 补充：`dsh-gen3d` 已随包提供自包含 `prepare` 脚本 `tsc -p tsconfig.build.json`，git 安装路径在 profile 侧配置 `allowBuilds` 后亦可用；registry 仍是唯一推荐分发方式。）
4. 清理：`dsh plugin remove` + 删除测试 profile 目录。
5. **2026-08-20 对齐 rc.8**：本机 npm 全局 `dsh@0.1.0-rc.8`（`npm i -g @deepseek-ai/dsh@0.1.0-rc.8`，先经 `which dsh` / `npm ls -g --depth=0` 确认原为 rc.6）；`@deepseek-ai/cordis` npm 最新仍为 `4.0.1`，未改动。`dsh-gen3d` 三依赖（dsh-tools / dsh-jobs / dsh-skill）升 `0.1.0-rc.8` 后 `pnpm build` 通过、338 测试全绿，类型无漂移、无需代码适配；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 由 pnpm 自动并入 rc.8 条目。冒烟：`pnpm pack` → `dsh plugin --profile gen3d-smoke add ./dsh-gen3d-0.1.0.tgz` → `--dump-config` 出现 `# == dsh-gen3d` 层（行 314-316）→ 临时 headless profile（bundles 含 dsh-base + dsh-headless + dsh-gen3d）跑一次性提示词，实际调用 `gen3d_provider_status` / `gen3d_credentials_status`：四家供应商均 `configured: false`、`mode: mock`，回退确定性 mock 且零费用；全程无 `ERR_MODULE_NOT_FOUND` 类依赖问题。清理：`dsh plugin remove` + 删除测试 profile（gen3d-smoke 与临时 headless profile）+ 删除 tarball。
6. **2026-08-24 对齐 0.1.1-rc.2 + 无头 E2E 两个真 bug 修复**：本机 npm 全局 `dsh@0.1.1-rc.2`，官方 changelog 插件面无 breaking change，但 rc.2 无头冒烟暴露两个真实问题（mock 链路即可触发）——
   - **问题 1（jobs inject 缺失）**：长任务路径 `ctx.jobs.start` 被 Cordis 注入守卫拦下：`Error: cannot get property "jobs" without inject`。根因：`src/index.ts` 的 `inject` 只声明了 `['tools','credentials','skills']`，漏了 `jobs`。修复：补 `'jobs'`（jobs 由 dsh-jobs-local 提供；tools / credentials / skills 由 dsh-base 恒提供），`src/index.test.ts` 的 inject 断言与用例名同步更新。
   - **问题 2（宿主服务包双实例 Symbol 漂移）**：`dependencies` 里的 dsh-tools / dsh-jobs / dsh-skill / dsh-settings（0.1.0-rc.8）被 `dsh plugin add` 装进 profile 的 `node_modules`，遮蔽 fallback 池（`~/.dsh/profiles/node_modules`）里 host 闭包的 0.1.1-rc.2 单实例——dsh-tools 的 `TOOL_RUNTIME_SCHEDULER` 等 Symbol 跨实例不一致，agent-loop 调任何工具都炸 `Cannot read properties of undefined (reading 'prepare')`。修复：4 包挪到 **peerDependencies**（`^0.1.0-rc.8`，与 client 双声明风格对齐）+ **devDependencies 钉 `0.1.1-rc.2`**（与 host 闭包对齐，供本地开发/测试）；profile 侧 `autoInstallPeers: false` → peer 不落 profile node_modules，运行期上溯 fallback 池单实例。连带发现：pnpm 对**混合 rc.8 / rc.2 基线**的 peer 区间做交叠解析会炸（样例：`@deepseek-ai/dsh-llm@>=0.1.1 <0.2.0-0` 无匹配，pnpm 把 `^0.1.1-rc.2` 下界提升为稳定版后任何已发布 pre-release 都不满足）——因此 client 系列 devDeps 也一并升 `0.1.1-rc.2`（`next` 标签有发布，见本文件头注）；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 按既有条目模式并入 rc.2（本机无 `minimumReleaseAge` 实际值，属惯例维护）。
   - **修复后验证**：`pnpm vitest run` 362 全绿、`tsc -p tsconfig.build.json --noEmit` 零错误、`pnpm build` 通过。E2E：`pnpm pack` → `dsh plugin --profile gen3d-e2e add ./dsh-gen3d-0.1.1.tgz` → profile `node_modules` 内**无 4 包任何副本**（只剩 cordis/cosmokit/schemastery 等真 dependencies）→ `--dump-config` 出现 `# == dsh-gen3d` 层 → 全新工作区一次性运行 `gen3d_provider_status` / `gen3d_credentials_status`：四家 `configured: false`、`mode: mock`，**全程无 `reading 'prepare'` 报错** → mock 生成端到端 `gen3d_text_to_3d`（meshy，真实工具+长任务 jobs 路径）：工具成功、`usedMock: true`、`cacheHit: false`、GLB 落盘（`xxd -l4` = `glTF` magic）、sidecar `custom.providerMode: "mock"`、`audit.jsonl` 出现**真实 submit 事件**（全新工作区，非 cache_hit）。清理：`dsh plugin remove` + 删除测试 profile（gen3d-e2e）+ 删除 tarball + 删除本次一次性会话目录。
7. **2026-08-24 双形态 E2E（软渲染预览管线 + web 视窗）**：rc.2 下验证 `gen3d_render_preview` / `gen3d_inspect_asset` 两条新工具与 web 端 `conversation.view` 页签 / keyed 工具卡片（无头 + web 双形态；全程 mock，无 key，未触发审批）。
   - **Blocker 级 bug（gifenc ESM 互操作）**：`pnpm pack` → `dsh plugin add` → 无头启动即崩：`Named export 'GIFEncoder' not found. The requested module 'gifenc' is a CommonJS module`（`lib/render/encode.js:10` 具名导入；单测 420 全绿未拦截）。根因：gifenc 的 package.json **无 exports 字段**——Node ESM 解析 `main`（CJS dist，esbuild `__export` 的 getter 导出不被 cjs-module-lexer 识别 → namespace 只有 `default`）；vite/vitest 却解析 `module` 字段（ESM dist，具名导出直挂 namespace，`default` 反而是 GIFEncoder 函数）。修复：`src/render/encode.ts` 改命名空间导入 + 按形状二选一（namespace 上有 `GIFEncoder` 用 namespace，否则取 `ns.default`），`src/render/vendor.d.ts` 注释同步；修复后 420 单测全绿，且 `node` 直跑 `encodePng`/`encodeGif` 输出 PNG/GIF magic 正常。教训：**纯 ESM 宿主的加载互操作必须按 Node 解析路径实证，vitest 全绿不代表宿主能加载**。另注：`dsh plugin --profile <新名> --help` 会**自动初始化空 profile**（bundles 只有 dsh-base）——查帮助 / 建 profile 的先后会互相干扰。
   - **无头 E2E**：`dsh plugin --profile gen3d-e2e add ./dsh-gen3d-0.1.1.tgz` → `--dump-config` 出现 `# == dsh-gen3d` 层（profile node_modules 无 4 个宿主包副本）→ `GEN3D_WORKSPACE_ROOT=/tmp/gen3d-e2e dsh --profile gen3d-e2e '<串行三连提示词>'` 一次性运行：agent 依次 `gen3d_text_to_3d`（meshy，prompt「a small orange fox robot, full body, a-pose」，返回 background `jobId=gen3d-1`）→ `job_output {job_id, wait:true}` 轮询至完成（`usedMock: true`、`cacheHit: false`、`assetPath` 齐全）→ `gen3d_inspect_asset`（`budget=hero-character`：558 顶点 / **1032 三角形**、`passed=true`）→ `gen3d_render_preview`（`angles=8`、`size=512`：text 块 + **2 个 image attachment 块** + 落盘 `.dsh-gen3d/previews/<stem>-contact.png`（PNG 4096×512）与 `<stem>-turntable.gif`（GIF89a 512×512））。工件核对：GLB 20,588B 且 `glTF` magic、sidecar `providerMode: "mock"`（`faceCount` = 请求目标面数 30000，实际几何 1032 面）、`audit.jsonl` 含**真实 submit 事件**（全新工作区、非 cache_hit）；会话日志 0 处 `reading 'prepare'` / `without inject` / webServer 相关报错（headless 无该服务，ctx.get 防御静默跳过）。
   - **web E2E**：`dsh --profile gen3d-web --no-open --port 0`（注意：`dsh web` 子命令**不接受前置 `--profile`**；端口从 stdout `dsh web: http://127.0.0.1:<port>` 取）。浏览器加载 `client.js?rev=…`（1.58MB）→ 会话视图 keyed 页签条「对话 / 轨迹 / **3D 资产**」→ 资产列表出现预置角色（characters 槽）→ 选中后 web 视窗（three.js）渲染出 mock 角色，顶栏显示「1,032 面」，canvas 区域像素方差 965（stddev 31，非纯背景）→ console **0 error**（仅 1 条 three `PCFSoftShadowMap deprecated` 警告，可容忍）。路由验证表：`GET /plugins/dsh-gen3d/api/assets` → 200 `application/json`（含 `faceCount`/`previews` 字段）；`GET /plugins/dsh-gen3d/files/assets/3d/characters/<name>.glb` → 200 `model/gltf-binary`；`GET /plugins/dsh-gen3d/client.js` → 200 `text/javascript`；穿越 `../` → 404、`%2e%2e%2f` / `..%2f` → 400；缺失资产 → 404。web 会话内发消息让 agent 跑 `gen3d_render_preview`（mock，未触发审批）：工具执行 + 最终答复带两条预览路径。
   - **发现（非 blocker，仅记录未修复）**：keyed 工具卡片 `RenderPreviewCard` 未展示预览图——工具侧 `output.render` 输出的是纯 prose 文本块（text 自足供 text-only 模型读），而 `src/client/tool-cards-model.ts` 按「text 块 = 规范值 JSON」摄取（`canonicalValue` → `JSON.parse` 失败 → null → `previewPathOf` 取不到 `previewPng`），卡片落到 `GenericRow` 通用行（槽命中可由行头「gen3d_render_preview」确认）。建议后续：preview / inspect 的 render 首块保留 `JSON.stringify(value)` 前缀，或卡片从 image attachment 块反取路径。
   - **presentationMeta 复验（2026-08-24，上述「发现」修复后的 web E2E）**：修复已落地——preview / inspect 的 `output.render` 维持 prose（text-only 模型自足），结构化展示数据改经 `output.presentationMeta` 写入 `tool/result.meta`（`src/tools/preview.ts:196`、`src/tools/inspect.ts:235`），web 侧 `metaOf(result.meta)` 与 `canonicalValue` 二选一补位（`src/client/tool-cards-model.ts:89`、`src/client/tool-cards.tsx:138`），`previewPathOf` 即可取到 `previewPng`。复验过程：全新 web profile（gen3d-web2，port 0）+ tmp mock 工作区（先用临时 headless profile 一次性生成 `tiny-blue-wizard-robot`）→ web 会话发消息「请调用 gen3d_render_preview 工具，asset 用刚生成的角色，angles 4，size 512」，agent 先 `gen3d_list_assets` 定位再调工具（mock，无审批）→ **keyed 卡片渲染出预览图**：`<img src="/plugins/dsh-gen3d/files/.dsh-gen3d/previews/tiny-blue-wizard-robot-contact.png">`，DOM `naturalWidth=2048` / `naturalHeight=512` / `complete=true`（4 视角 × 512px 拼板，与 angles 4 / size 512 吻合），卡片头「完成 / 渲染预览」+ 事实行（预览图路径、对应资产 + 打开文件按钮），**不再是 GenericRow 通用行**。回归：会话页签「对话 / 轨迹 / 3D 资产」仍在；console **0 error**（仅既有 three `PCFSoftShadowMap deprecated` 警告 ×2，与条目 7 前次一致）。证据截图：`/tmp/gen3d-card-proof.png`（视口，卡片全貌 + img 可见）。注：复验中途会话视图曾自动回到欢迎屏（会话树仍保留该会话条目），重进会话后 DOM 复验一致——卡片 img 由会话历史重放渲染，幂等。
   - 清理：`dsh plugin remove` ×2 + 删除两个测试 profile 目录 + `/tmp` 工作区与 tarball + 仅本次的会话目录；既有 headless/web profile、`~/.dsh/.credentials.yaml`、`settings.yaml` 均未动。

8. **2026-08-24 真实 Meshy API 全链 E2E（首次真实计费跑通）**：真实 `MESHY_API_KEY`（`~/.dsh/.env` 第四层，0600）+ web 面审批，跑通 `refine → inspect → render_preview → (remesh) → auto_rig → apply_motion` 全链（`usedMock:false`、产物全部落盘）。余额 2990 → 2857（全程累计 133 积分，含首批试错）。
   - **首批 50 积分学费（三个环境坑，均非插件缺陷）**：① `settings.yaml` 的 `permission.defaultPreset: danger-full-access` 使会话 `approval/policy=never` 确定性拒绝计费工具——web UI 切 Workspace Write 后审批正常（`allowed-once`）；② host 0.1.1-rc.2 会中止长阻塞工具等待（`job_output wait=true(600s)` 在 448s 被 signal abort，整轮夭折）——改 `wait:false` 短轮询可规避；③ 本机代理把 `api.meshy.ai` 解析到 fake-IP 段（198.18.0.x），TLS 间歇性成片掐断（实测失败率 10–25%），轮询中任务被网络错误杀死。**重要**：两批共 5 个「云端 SUCCEEDED 但插件未取回」的任务因此作废——网络层瞬断重试缺口已记入 KNOWN-GAPS §14。
   - **Meshy 云端实证**：`GET /openapi/v2/text-to-3d?sort_by=-created_at` 列表确认本批 preview/refine 任务全部 `SUCCEEDED`——**meshy-7（latest）对该账号开放**，提交参数合法（无 400「Model not available」）；已付费的 SUCCEEDED preview 任务可经 List 端点找回 id 续用（本次即从此恢复，省 20–30 积分）。
   - **全链证据**（工作区 `/tmp/gen3d-real2`，155MB 产物保留）：refine（task `01a0341e`，84MB GLB / 1,955,150 面 / 4 张 PBR 贴图）→ inspect（1.95M 面超 hero-character 预算，agent **按 game-3d-assets 技能自发**走 `gen3d_retopo_lowpoly` 降档——技能验证闭环在真实环境自主执行成功）→ remesh（task `01a0342c`，5 积分，55,328 面；目标 30k 被官方近似为 55k，符合「实际面数可能有偏差」）→ render_preview（软渲染器连 2M 面原模型也能出图）→ auto_rig（task `01a0344e`，5 积分，rigged GLB 7.9MB + FBX + 免费 walk/run clip；**1.95M 面原模型直绑被官方 30 万面上限 400 拒绝**，与文档一致）→ apply_motion（task `01a03452`，3 积分，animated GLB 7.9MB + FBX，`readiness.animated=true`）。web 视窗真实渲染橙色喷气狐狸（截图 `/tmp/gen3d-screenshots/01`），render_preview 卡片显示预览图。
   - **发现并当日修复**：`gen3d_auto_rig` / `gen3d_apply_motion` 成功提交不写 audit submit 事件（动画工具不经 `generateCacheFirst`）——已补 `mode: 'rig' | 'motion'` 审计（`GenerationMode` 联合类型相应拓宽），含 autoReRig 重绑分支，幂等命中不重复写。
   - **遗留观察**：remesh 目标面数与产出有官方口径内偏差（30k→55k）；hero 预算档剩 2 条违规（55k 面 / 4096 贴图）属如实标注；代理 fake-IP 环境建议给 `api.meshy.ai` 配直连或稳定出口（profile 副本打 fetch 重试补丁实测可根治，仓库侧方案见 KNOWN-GAPS §14）。
   - 清理：临时 profile / tarball / 服务进程全部清除；`~/.dsh/.env`（用户 key）、既有 profile 与设置未动；产物与截图存 `/tmp`（不入仓库）。

9. **2026-08-25 修复后复跑真实全链（0.3.0 验证）**：registry 安装路径实证——bare `add dsh-gen3d` 在 0.2.0 发布当口因 pnpm 发布冷却（minimumReleaseAge）回落装到 **0.1.0**（其 dependencies 带宿主服务包，会触发条目 6 的双实例漂移），显式 `dsh-gen3d@0.2.0` 解决，README 已加安装注记。**§14 缺口放大复现**：refine 取回连续 3 次 `fetch failed`（云端 3 个 SUCCEEDED 作废、30 积分），remesh 取回失败 1 次；Node fetch 实测到 `api.meshy.ai` 延迟抖动 5.7–10.4s。修复（幂等 GET 重试 + body 纳入重试单元 + 防重复计费指引，见 KNOWN-GAPS §14）后同环境复跑：retopo ×2 → rig → walk/run（免费）→ jump 全链**一次取回成功**，交付 `merged.glb`（26,550 面 / 3 clips / 2048 贴图 / 材质修复）+ `playable.json`，本段计费 18 积分。两个新缺口由会话内 agent 实证并登记：KNOWN-GAPS §15（软渲染蒙皮 / 金属失真）、§16（export 合并 `motion_read_failed`，adopt 路径等价绕过）。web 视窗验收（0.3.0 升级）：IBL + ACES 下带贴图模型观感正常、动画自动播放与 clip 切换在位、图片资产内联预览。另实证：会话进行中权限模式下拉框对后台注入点击不响应（仅欢迎屏可切换）——web 自动化驱动的注意点。

---

## 9. dsh-gen3d 落地要点（结论清单）

1. 包形态：`dsh.bundle.patch` + `cordis.patch.yml` 单行 `insert`；宿主服务包（dsh-tools / dsh-jobs / dsh-skill / dsh-settings）走 **peerDependencies + devDependencies**（dev 钉与宿主一致的版本，供本地开发/测试）——刻意不进 dependencies，避免 `dsh plugin add` 把它们装进 profile 的 node_modules、遮蔽宿主闭包形成**双实例 Symbol 漂移**（dsh-tools 的 TOOL_RUNTIME_SCHEDULER 等跨实例不一致，agent-loop 调任何工具即炸，见第 8 节条目 6）；分发用 `npm pack` tarball。
2. 21 个 `gen3d:*` 工具全部用 `defineTool` 重写（与 `src/tools/index.ts` 一致：11 生成 + 3 动作 + 5 playable + 2 资产工具）：`parameters` 用 DSL（含 `enum`/`oneOf` 表达 Mesh 类型、贴图分辨率等枚举），`output.schema` 声明规范值（含失败原因的结构化表达），`output.render` 输出模型 prose。
3. 计费工具（文生3D/图生3D/多视图/精修/绑骨等）在 `tools/pre-execute` 统一返回 `{ kind: 'ask', reason }`；默认组合自带 `dsh-user-approval`（policy `ask`），无审批通道时自动 fail-closed。
4. 密钥：`inject: ['credentials']`，每次操作 `resolve(credentialRef('MESHY_API_KEY'|'HUNYUAN3D_API_KEY'))`，`undefined` → 确定性 mock 回退；用户写入 `$DSH_HOME/.credentials.yaml` 或环境变量，插件零内置（⚠ rc.2+ 主机上 `.credentials.yaml` 由 host 接管为版本化格式，见 §4.3 注与 `docs/CREDENTIALS.md`）。
5. 长任务（Meshy 两阶段精修等）：`ctx.jobs.start({ kind: 'gen3d', owner: exec.agent, ... })` + `declare module '@deepseek-ai/dsh-jobs'` 扩展 `JobKindMap`（无 `./types` 子路径，见 5.2 节）；返回 `{ kind: 'background', jobId }` 结构句柄。**用 `ctx.jobs` 必须在 inject 声明 `jobs`**（jobs 由 dsh-jobs-local 提供；漏声明即被 Cordis 注入守卫拦截 `cannot get property "jobs" without inject`）。
6. skill：包内 `skills/generate-3d-character/SKILL.md`（kebab-case 名 + name/description frontmatter），在 `apply` 里用 `ctx.skills.registerProvider()` 自注册随包 provider（第 6.3 节方式 2，`import.meta.url` 只在插件模块内合法，patch 的 `!!js` 求值环境没有它）。
7. 工具卡片：`presentCall` 用 `generic` 卡片 + `locations`（写出的 GLB 路径）；`presentResult` 用 `generic`（附结果摘要）或 `diff`（生成的 playable.json）。

## 10. 设置卡片（插件自注册 settings card，rc.7+）

> 依据：官方 `docs/cookbook/adding-a-settings-card.md`（rc.7 起，rc.8 未改）与
> PR deepseek-harness#2404（`feat/plugin-owned-settings-surface`）。rc.7 把
> `settings.plugin.item` 从 list 槽改为 **keyed 槽**，并删除 api-proxy 的
> 硬编码命名空间白名单（rc.6 的 `settings-not-exposed`）——这是 out-of-tree
> 插件卡片可用的前提。

### 10.1 两条半边

- **host 半边**（包根 `src/`）：`@deepseek-ai/dsh-settings` 的
  `installSettingsSection(ctx, ns, schema, entry, hooks)` 注册命名空间
  （`settingsNamespace('xxx')` 品牌化，必须 lowercase kebab）；schema 是
  `@deepseek-ai/schemastery` 的 `z.object`（缺省用 `.default()` 静态值）。
  解析层序：schema 默认值 → composition `base` → user 层；`user` 字段
  **存在**即覆盖。`inject: ['settings']`，settings 服务缺席时整体不生效。
- **浏览器半边**（`src/client/`，`dsh.client` 双面包的 client 面）：
  `inject = ['slots', 'connection', 'settingsScope']`，`apply` 里
  `ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name:
  'settings.plugin.item', key: <命名空间>, inject: () => controller.inject() },
  Card))`；key = host 命名空间即 join key。`ctx.settingsScope.bind({ namespace })`
  → `SettingsScope<T>`（`getSnapshot/subscribe/set(field)/unset(field)`，
  **set 只写节内顶层字段**，嵌套路径不可用）；configured/writable 事实经
  `connection.api.credentials.describe({refs})`（永不含值）。组件自绘 chrome，
  官方 `PluginCard`/表单不可值导入（bundle 纯度门）。

### 10.2 打包与构建（out-of-tree 自复刻要点）

- `package.json`：`exports["./client"]` → 浏览器 bundle；`dsh.client =
  { platform: 'web', inject: [提供注入服务的包名…] }`。client-modules 按
  loader 条目扫描 `require.resolve('<pkg>/package.json')`（baseUrl = cordis.yml
  所在目录），服务 `/plugins/<pkg>/client.js`，无需重编 web 应用。
- 官方 `tsdown` 的 `clientBundle` 预设**未发布**，需自复刻输出格式（本仓库
  `tsdown.config.ts`）：CJS + browser，`format: 'cjs'`，externals = 平台模块表
  （`react` 系列 + `@deepseek-ai/cordis` + `dsh-client-ui-slots` + `dsh-client-ui-primitives`）
  + `@deepseek-ai/dsh-client-runtime/client`（rc.8 预载项），`noExternal` 其余全内联；
  `outputOptions`：`entryFileNames: 'client.js'`、banner `window.__ModuleLoader__.load({
  id: "<包名>", factory: (require) => {`、intro `var module = { exports: {} }; var
  exports = module.exports;`、footer `return module.exports; } });`；同时自复刻
  bundle 纯度门（平台模块外的一切 `@deepseek-ai/*` 值导入报错；type-only 导入已擦除）。
- rc.8 另新增 `dsh.client.external`（模块图边）；rc.7 部署别声明该字段。
