# DSH（DeepSeek Harness）插件开发 API 精读

> 面向 dsh-gen3d 迁移的权威参考。所有源码引用以本机浅克隆的 DSH 官方源码仓库
> （下文记作 `<repo>`）为准，标注格式为 `路径:行号`。实测验证基于本机 npm
> 全局 `dsh@0.1.0-rc.6` 与 registry 上的 `@deepseek-ai/dsh-tools@0.1.0-rc.6`
> （见第 8 节）。

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

要点：后台分支返回结构化句柄（Code Mode 绝不解析 prose 里的 id）；注册表拒绝预中止的调用；`run()` 开始前运行时校验 owner 与控制器可用性；工具面控制工具 `job_kill`/`job_list`/`job_read` 由 `dsh-tool-jobs` 提供（`capability-seams.md:459`）。

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
3. **陷阱（link 安装不解析依赖）**：`dsh plugin add ./目录`（pnpm `link:` 安装）时，插件包自身的 `dependencies` **不会**被 pnpm 解析安装，ESM import `@deepseek-ai/dsh-tools` 报 `ERR_MODULE_NOT_FOUND`；先 `npm pack` 再 `dsh plugin add ./xxx.tgz` 则依赖正确 hoist 到 profile `node_modules`（实测通过）。**分发必须用 tarball 或 registry，不要用目录链接。**
4. 清理：`dsh plugin remove` + 删除测试 profile 目录。

---

## 9. dsh-gen3d 落地要点（结论清单）

1. 包形态：`dsh.bundle.patch` + `cordis.patch.yml` 单行 `insert`；依赖走 registry 版本并随宿主 dsh 版本核对；分发用 `npm pack` tarball。
2. 25 个 `gen3d:*` 工具全部用 `defineTool` 重写：`parameters` 用 DSL（含 `enum`/`oneOf` 表达 Mesh 类型、贴图分辨率等枚举），`output.schema` 声明规范值（含失败原因的结构化表达），`output.render` 输出模型 prose。
3. 计费工具（文生3D/图生3D/多视图/精修/绑骨等）在 `tools/pre-execute` 统一返回 `{ kind: 'ask', reason }`；默认组合自带 `dsh-user-approval`（policy `ask`），无审批通道时自动 fail-closed。
4. 密钥：`inject: ['credentials']`，每次操作 `resolve(credentialRef('MESHY_API_KEY'|'HUNYUAN3D_API_KEY'))`，`undefined` → 确定性 mock 回退；用户写入 `$DSH_HOME/.credentials.yaml` 或环境变量，插件零内置。
5. 长任务（Meshy 两阶段精修等）：`ctx.jobs.start({ kind: 'gen3d', owner: exec.agent, ... })` + `declare module '@deepseek-ai/dsh-jobs'` 扩展 `JobKindMap`（无 `./types` 子路径，见 5.2 节）；返回 `{ kind: 'background', jobId }` 结构句柄。
6. skill：包内 `skills/generate-3d-character/SKILL.md`（kebab-case 名 + name/description frontmatter），在 `apply` 里用 `ctx.skills.registerProvider()` 自注册随包 provider（第 6.3 节方式 2，`import.meta.url` 只在插件模块内合法，patch 的 `!!js` 求值环境没有它）。
7. 工具卡片：`presentCall` 用 `generic` 卡片 + `locations`（写出的 GLB 路径）；`presentResult` 用 `generic`（附结果摘要）或 `diff`（生成的 playable.json）。
