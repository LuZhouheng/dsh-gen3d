# 已知能力缺口（dsh-gen3d）

> 状态：🟡 快照（2026-08-25，与 `src/` 代码现状对齐；§10 为 2026-08-20 实测解决记录，
> §11–§12 为 2026-08-24 与 DSH 0.1.1-rc.2 环境对齐时新增，§13 为 2026-08-24 视口预览与
> 交互视窗落地时新增，§14 为 2026-08-24 真实 API 全链 E2E 后新增（2026-08-25 meshy 路由
> 修复），§15–§16 为 2026-08-25 修复后复跑全链时由会话内 agent 实证发现）。
> 本文件逐条记录当前实现的
> 已知能力缺口：**影响**（用户/链路会看到什么）、**规避方式**（当前可行路径）、
> **后续计划**（补齐方向）。凡标注「待补」的条目，补齐后须同步删除或改写对应
> 小节，并把状态翻绿。
>
> 能力面总览（四家供应商）见 [README 能力矩阵](../README.md)；每家的协议细节见
> `docs/providers/*-api.md`。错误码契约见 `src/providers/types.ts` 与
> `src/tools/common.ts` 的 `toToolFailure`。

## 1. Hunyuan3D 未实现公共契约 `submitAnimation`

**现状**：`src/providers/hunyuan3d.ts` 没有公共契约 `Gen3dProvider.submitAnimation`
（可选能力，工具层经 `'submitAnimation' in provider` 探测）。已有的相关能力是：

- `submitRig` 已实现：TC3 `SubmitAutoRiggingJob`，`providerOptions.motionType`
  （官方 48 个预设，MotionType 1–48）可在**绑骨时**直接附带一个预设动作；
- `submitMotionJob` 已实现（TC3 `SubmitHunyuanTo3DMotionJob` 文生动作），但只是
  provider 扩展方法，**未挂接到公共契约**，工具层不可达。

**影响**：`gen3d_apply_motion` 的 Hunyuan3D 路由（`rigProvider=hunyuan3d`）探测不到
`submitAnimation`，对已绑骨资产套动作会报
`provider_capability_missing`（提示语：可在 auto-rig 时经
`providerOptions.motionType` 指定）。即：Hunyuan 侧「先绑骨、后单独加动作」的
两段式流程走不通，只能「绑骨时顺带一个预设动作」。

**规避**：绑骨阶段就经 `providerOptions.motionType` 选好预设动作（一次绑骨带
一个动作，需重绑才能换动作）；或把需要后补动作的资产走 Meshy 路由。

**后续计划**：把 `submitMotionJob` 挂到公共契约 `submitAnimation`（`AnimationRequest`
→ `SubmitHunyuanTo3DMotionJob` 参数映射，含 `retargetFileUrl`/`duration` 等），
并让 `gen3d_apply_motion` 的 Hunyuan 路由走通「已绑骨资产追加动画」。

## 2. Tripo3D 外部 GLB 绑骨需 `import_model` 链路（未实现）

**现状**：Tripo3D 官方 `animate_rig` 只接受「Tripo 侧带模型输出的任务 id」，**不
接受外部模型 URL**；外部模型须先经 `import_model` 导入（官方文档 §animate_rig）。
`src/providers/tripo3d.ts` 目前只有图片上传 `uploadImage`（`/upload/sts`），
**未实现模型导入** `importModel`（`/import_model` + 任务轮询）。

**影响**：`gen3d_auto_rig` 的 Tripo3D 路由只对「由 Tripo3D 生成、sidecar 记录了
`sourceJobId`」的资产可用；Meshy / Hunyuan3D / Rodin 生成的资产或 mock 资产走
Tripo 路由会报 `missing_input_task`（提示改走 meshy / hunyuan3d 路由）。

**规避**：Tripo 绑骨仅用于 Tripo 生成的资产；其余来源的资产绑骨走
meshy（默认）或 hunyuan3d 路由。

**后续计划**：补 `importModel`（上传 GLB → 轮询导入任务 → 拿模型任务 id），在
`gen3d_auto_rig` 的 Tripo 路由里接入「外部 GLB → 先导入再绑骨」。

## 3. hunyuan3d 真实路径仍需公网源 URL；meshy 路由已落地（本地 GLB Data URI 直传）

**现状**：`gen3d_retopo_lowpoly` 的真实路径分三支：

- `meshy`（已落地，首选规避路径）：Meshy 生成的资产经 sidecar
  `custom.meshyTaskRefs.resultTaskId`（或显式 `originalTaskId`）走 Remesh API 的
  `input_task_id`；**本地任意 GLB 读文件转 Data URI（`application/octet-stream`）
  作 `model_url` 直传，无需公网 URL**（官方 Remesh 支持公网 URL 或 Data URI，
  详见 `docs/providers/meshy-api.md` §6）；5 积分 / 次，`targetPolycount` /
  `detailLevel`（→`decimation_mode`）/ `polygonType`（→`topology`）映射见该节注记；
- `hunyuan3d`（默认，仍受官方约束）：TC3 `Submit3DSmartTopologyJob`，需 `sourceUrl`——
  **公网可达**的源 GLB URL（官方约束，输入文件要公网 URL）；
- `tripo3d`：智能低模，需 `originalTaskId`——Tripo 侧带模型输出的任务 id。

本地资产既没有内置对象存储，也没有模型上传链路（Tripo `import_model` 未实现，
见 #2），所以 **hunyuan / tripo 两路由**对本地资产仍有来源限制；**meshy 路由无此
限制**（本地 GLB Data URI 直传）。mock 路径不需要 URL。

**影响**：

- meshy 路由：从本地资产（或 Meshy 生成资产）出发可直接重拓扑，流程与
  「生成→绑骨→动作」（Meshy 全程无需公网 URL）一致，无额外上传步骤；
- hunyuan / tripo 路由：本地资产仍缺来源——Hunyuan 智能拓扑缺 `sourceUrl` 时报
  `missing_source_url`；Tripo 智能低模仅限 Tripo 自身生成的资产。

**规避**：走 `gen3d_retopo_lowpoly` 时优先 `provider=meshy`——本地任意 GLB 直接可走
（Data URI 直传），Meshy 生成资产自动取 sidecar 的 `resultTaskId`（`originalTaskId`
优先级最高）；用户已有公网源直链或 Tripo 生成任务时才考虑 hunyuan / tripo 路由。

**后续计划**：Tripo `import_model` 落地后（#2），本地 GLB 可经上传链路直接走
Tripo 智能低模，三家齐备（meshy 的 `input_task_id` / Data URI、tripo 的
`import_model`、hunyuan 的公网 URL）；Hunyuan 侧受官方「公网 URL 输入」约束，
仍需用户自备直链，文档标注清楚。

## 4. Rodin 无绑骨 / 动作 / 重拓扑，且 API 需 Business 订阅（$120/月）

**现状**：`src/providers/rodin.ts` 只覆盖**生成**（text / image / views）、
**拆分**（Bang addons）、**重贴图**（`rodin_texture_only`，模型 ≤10MB）；没有
`submitRig` / `submitAnimation` / `listMotions`（工具层探测不到即为能力缺失），
也没有独立重拓扑端点（低模只能靠生成时的面数档位近似）。API access 仅
Business 及以上订阅可用（官方定价 $120/月），非订阅调用报
`SUBSCRIPTION_PLAN_TOO_LOW`（实现按 `provider_unauthorized` 处理并附提示）。

**影响**：Rodin 不参与绑骨 / 动作 / 低模路由（`gen3d_auto_rig` 的 auto 顺序为
meshy → hunyuan3d → tripo3d，不含 rodin）；作为生成 / 重贴图的可选增强供应商，
订阅门槛是四家中最高的。

**规避**：文档与 `provider-status` 明示 Rodin 能力边界与订阅门槛；未订阅时
按未配置处理（mock 回退），不静默走其他家。

**后续计划**：维持定位（可选增强供应商），不计划补绑骨 / 动作 / 重拓扑。

## 5. 旧版静态 JSON Schema 已移除

**现状**：迁移期曾随包保留一份旧工具的 args/returns 静态 JSON Schema 参考目录；
DSH 工具的参数与输出 schema 已全部改为 `defineTool` DSL **内联**在 `src/tools/*.ts`
（`common.ts` 的 `ParameterSchemaSpec` / `resultSchema`）。为避免双份参数定义并存，
该目录已在公开分发前整体移除。

**影响**：无——工具契约以 `src/tools/` 为唯一事实来源。

## 6. Hunyuan 3.1 八视图：第 8+ 张需 `viewNames` 显式传名

**现状**：`src/providers/hunyuan3d.ts` 的 `buildViewsParams` 缺省视角名序列按官方
文档列出的 7 个视角名分配（`left/right/back/top/bottom/left_front/right_front`）。
`hy-3d-3.1` 官方宣称八视图，但官方文档未列全 8 个视角名——**第 8 张（以及任何
超长输入）必须经 `providerOptions.viewNames` 显式提供完整视角名单**，否则报
`provider_bad_request`（「图片数量超过可用视角名数量」）。

**影响**：3.1 八视图想用满 8 张时，工具层需额外透传 `viewNames`（当前
`gen3d_views_to_3d` 支持经 `providerParams` 透传），缺省 7 张以内不受影响。

**规避**：3.1 用满八视图时显式传 `viewNames`；或按 3 视角（3.0）提交。

**后续计划**：官方确认第 8 视角名后并入缺省序列（`HUNYUAN_MULTI_VIEW_DEFAULT_NAMES`）。

## 7. Tripo 下载 URL 有效期文档自相矛盾（5 分钟 vs 60 秒）

**现状**：Tripo3D 官方任务查询文档称下载 URL 默认 **5 分钟**后过期，FAQ 第 10
条则称下载遇 403 是因为链接仅 **60 秒**有效——两处官方记载不一致（见
`docs/providers/tripo3d-api.md` §0 / §7）。实现按「**查询成功后立即下载，403 时
重查任务再取新链接**」兜底（`tripo3d.ts` `pollTask`），不依赖任何一侧的时限。

**影响**：无功能影响（有兜底）；唯一代价是下载失败时多一次任务查询。

**规避**：无需规避；工具层 `providerResultFromTask` 已按「立即下载」实现。

**后续计划**：维持兜底策略；若官方文档后续统一时限，可把「403 重查」收窄为
仅按官方口径触发。

## 8. Meshy `CANCELED` 暂映射 `provider_http_error`

**现状**：`src/providers/meshy.ts` 轮询到任务终态 `CANCELED` 时抛
`provider_http_error`（`retryable: false`，`taskStatus: 'CANCELED'`），错误码表里
**没有独立的「任务已取消」语义码**。

**影响**：调用方（工具层 / AI）无法语义化区分「任务被取消」与一般 HTTP 错误；
对重试安全无影响（两者均不可重试），仅可读性差。

**规避**：无需规避；错误信息文本已含「任务已取消（CANCELED）」与 taskId。

**后续计划**：在 `src/providers/types.ts` 错误码契约新增 `provider_cancelled`，
`meshy.ts` 的 `CANCELED` 分支改映射该码，并同步 `toToolFailure` 透传。

## 9. 轮询 429 未做动态拉长间隔

**现状**：四家 provider 的轮询均为**固定间隔**（meshy 默认 5s / tripo3d 默认 2s /
hunyuan3d 默认 5s / rodin 默认 5s）；HTTP 429 统一映射
`provider_rate_limited`（可重试），但**轮询循环内部不会因 429 / 限流响应动态
拉长间隔**，也不读取 `Retry-After` 头（rodin 实现注释明确「轮询间隔固定 5s
勿改小」）。

**影响**：限流 / 队列积压场景下，固定间隔连续触发 429 可能造成重试风暴或提前
撞上轮询超时（`provider_timeout`）；不影响最终成功率（429 可重试）。

**规避**：通过依赖注入 `pollIntervalMs` 调大间隔；避开高峰时段。

**后续计划**：轮询遇 429（及可识别限流响应）时按 `Retry-After`（若存在）或
指数退避动态拉长下一次间隔，设上限封顶；四家统一实现。

## 10. ~~设置卡片的浏览器渲染未在真实 DSH web 部署端到端验证~~（✅ 已解决，2026-08-20）

**状态**：已在真实 rc.8 web 部署实测通过。本机 `dsh@0.1.0-rc.8`，临时 profile
`gen3d-e2e`（bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app@0.1.0-rc.8`
+ `dsh-gen3d@0.1.1` tarball），`dsh --profile gen3d-e2e --no-open --port 0` 起服务后
用 playwright 打开设置页。

**证据**：
- 设置 → 插件配置页出现「3D 生成供应商配置」卡片（位于终端 / Agent 循环 /
  网页搜索卡片之后——keyed 槽 `settings.plugin.item`（key=gen3d）与 serve 集合配对生效）；
- 四行供应商（Meshy / Hunyuan3D / Tripo3D / Rodin）在无 key 环境全部显示
  `mock`/未配置态，缺省引用即 `PROVIDER_ENV_KEYS`；TC3 口径与凭证域口径双注脚可见；
- 写路径往返通过：Meshy 引用临时改 `GEN3D_E2E_TEMP` → 保存 → 输入框更新 +
  「已覆盖」徽标 + 保持 mock（未知引用=未配置）→ 清除 → 恢复 `MESHY_API_KEY`；
- `/plugins/dsh-gen3d/client.js` 路由 200，boot manifest 含 dsh-gen3d 条目；
  浏览器 console 零错误零告警。

**清理**：停 web 服务、删除 `gen3d-e2e` profile 目录、删 tarball 与日志；
共享设置文档无残留（`gen3d: {}`）。截图存证在 /tmp（不入仓库）。

## 11. 凭证通道与 rc.2 host 版本化 `.credentials.yaml` 不兼容

**现状**：插件自实现凭证解析器（`src/config.ts` `parseCredentialsYaml`）只认扁平根
映射与旧 `credentials:` 包裹层；DSH host 0.1.1-rc.2 起 `~/.dsh/.credentials.yaml` 为
**host 管理的版本化格式**（`version: 1` + `refs:` 包裹），解析器遇 `refs:` 子树
**静默跳过、不抛错**（根级 `version: 1` 则被当作无害键吞掉）。host 对该文件格式
校验严格：**根级手工加键会导致 boot 失败**。

**影响**：用户在 host 管理的凭证文件里配置 `MESHY_API_KEY` 对插件不可见，
`providerConfiguredMap` 恒为 false，表现为 `configured: false` 走确定性 mock——
真实生成链路静默不可用（不报错），只在状态界面显示未配置。

**规避**：key 走**环境变量**（进程导出 `MESHY_API_KEY=...`）或 **`$DSH_HOME/.env`**；
不要手工编辑 `~/.dsh/.credentials.yaml`（详见 `docs/CREDENTIALS.md` §3.1 警示）。

**后续计划**：迁移到 DSH 官方凭证通道——`inject: ['credentials']` + 每次操作
`ctx.credentials.resolve(credentialRef('MESHY_API_KEY'))`（见 `docs/dsh-api.md` §4.4），
复用 host 的 refs 解析；迁移后删除 `src/config.ts` 自实现解析器（`loadCredentialLayers`
等相关函数）。

## 12. 一次性 headless 运行无法走真实计费路径

**现状**：7 个计费 gen3d 工具（= `billingToolNames`：文生3D / 图生3D / 多视图 / 精修 /
智能拓扑 / 绑骨 / 套动作）在判定本次调用将走真实 provider（非确定性 mock）时，经
`tools/pre-execute` 返回 `{ kind: 'ask', reason }`（`src/index.ts` 计费审批 gate）。
DSH 语义：ask 在审批服务缺失时 **fail-closed 降级为 deny**（`docs/dsh-api.md`
§3.2/§3.3）。一次性 headless 组合（dsh-base + dsh-headless + dsh-gen3d、无浏览器）
**没有审批 answerer** → `unavailable` → deny；`DSH_PERMISSION_MODE=danger-full-access`
只会把审批 policy 从 `ask` 变 `never`（`docs/dsh-api.md` §3.5），同样确定性拒绝。

**影响**：headless 一次性运行只能跑通 mock 路径（`configured: false` / `usedMock: true`）；
真实 API 端到端只能在 **dsh web 面**经浏览器批准完成：策略 `ask` → 审批卡片 →
批准后放行并计费。

**规避**：真实链路在 web 面运行；headless 仅用于冒烟 / mock 链路验证（与
KNOWN-GAPS #10 的 rc.8 实测方式一致）。

**后续计划**：观察官方是否提供「机器策略 / 非交互 answerer」（CI 场景的自动批准）；
若官方支持，再评估插件侧预置脚本或配置，无改动计划。

## 13. 软渲染预览为视口级观感，交互视窗仅 web 会话可见

**现状**：`gen3d_render_preview` 的预览图由纯 JS 软光栅渲染（Solid / Workbench 视口级
观感）：着色 / 光照 / 地面 / 阴影齐全，但**无 PBR 贴图采样、无 SSAO、无 IBL**（环境光遮蔽
与基于图像的照明不模拟）；交互视窗（实时查看）经 `conversation.view` 槽注入，**仅 web
会话可见**。

**影响**：预览用于形态 / 比例 / 朝向 / 布光自检可信，但**不能代表引擎内最终渲染效果**
（贴图细节、AO 与反射缺失，材质科以 `gen3d_inspect_asset` 指标为准）；headless / CLI
一次性运行只输出最终 text 块，用户看不到交互视窗，只能看**落盘预览文件**（PNG / GIF
路径）与文本指引。

**规避**：预览自检聚焦几何 / 比例 / 布局；贴图实际效果以 inspect 指标 + 引擎内导入为准；
CLI 用户由工具回报预览文件路径打开查看。

**后续计划**：评估软光栅内近似**贴图采样**（当前无纹理过滤）；评估 **headless-gl / GPU
渲染路线**（真实 PBR 观感 + 性能），作为后续可选升级。

## 14. ~~provider 网络层无瞬态重试（代理 fake-IP 环境会杀死进行中任务）~~（🔶 meshy 路由已修复，2026-08-25；其余三家待跟进）

**修复记录（2026-08-25，第二次真实 E2E 后落地）**：同一环境再次完整复现并放大——
refine 结果取回连续 3 次 `fetch failed`（云端 3 个 SUCCEEDED 任务全作废、30 积分），
remesh 取回亦失败 1 次；Node fetch 实测单请求延迟抖动 5.7–10.4s。已在
`src/providers/meshy.ts` 落地有界瞬态重试：幂等 GET（轮询 / 余额 / 资产下载，
**body 读取纳入重试单元**——大文件下载中途中断与连接失败同等重试）对网络类失败与
408/429/5xx 按 1.5s→3s→6s→12s 指数退避共 5 次尝试（`IDEMPOTENT_RETRY_*` /
`RETRYABLE_STATUSES`）；abort 不重试。POST 提交**不重试**（盲重试可能重复建单），
改为失败消息附防重复计费指引；取回侧最终失败的消息附任务 id 与「用 originalTaskId
接回成果」恢复指引（错误消息经工具层 `toToolFailure` 原样透传给 agent）。
单测 +6（`src/providers/meshy.test.ts`「传输重试」），445 全绿。
**未覆盖（仍开放）**：hunyuan3d / tripo3d / rodin 三家同款重试未做；POST 提交的
「先查任务列表去重再决定重发」恢复未做；Retry-After 头未消费（与 #9 一并）。

—— 以下为修复前的原始记录（保留作背景）——

**现状**：四家 provider 的 HTTP 调用（创建 / 轮询 / 下载）均为单次尝试；网络层瞬断
（TLS 握手失败、`fetch failed`、连接重置）直接以 `provider_http_error`
（retryable: true）终结本次任务循环。**任务已在云端创建并计费的情况下**，插件侧
失败不会取消云端任务——任务继续跑完，但插件未取回结果、资产不落盘、audit 无记录，
已耗积分无法追回（2026-08-24 真实 E2E 实录：本机代理把 `api.meshy.ai` 解析到
fake-IP 段 198.18.0.x，TLS 间歇成片掐断（实测失败率 10–25%），首批因此作废
5 个云端 SUCCEEDED 任务、约 50 积分，见 docs/dsh-api.md §8 条目 8）。

**影响**：网络不稳定环境（代理 / VPN / 抖动链路）下，长链路（preview→refine→
rig→motion）任一环节瞬断都会「烧钱不交付」；重试只能由上层（agent / 用户）
重新发起整步——而生成类步骤重发会**新建云端任务再次计费**（refine 一次 10 积分）。

**规避**：给 `api.meshy.ai`（及各家官方域名）配置直连 / 稳定出口（绕过 fake-IP
代理段）；本次 E2E 已在 profile 安装副本内打「fetch 瞬态重试」补丁实证可根治
（GET/轮询有界重试 + POST 仅 TLS 前段失败重试 1 次），但该补丁未落仓库。

**后续计划**：在 provider 共享 fetch 层（`src/providers/types.ts` 的 `resolveFetchImpl`
一带）实现**有界瞬态重试**：GET / 轮询 / 下载类安全请求指数退避重试（≤4 次）；
POST 创建类仅在可判定「请求未发出」（TLS 前段 / 连接阶段错误）时重试 1 次，
避免重复建单双重计费；Retry-After 头优先（与 #9 轮询退避一并设计）。

## 15. 软渲染预览对蒙皮 / 金属材质资产失真（方向倒置 + 黑屏 / 空图）

**现象（2026-08-25 修复后复跑全链，preview 产物实证）**：
`orange-fox-bot-lowpoly-contact.png` 中角色整体**倒置**（头朝下）且不采样贴图
（白模）；`orange-fox-bot-lowpoly.rigged_model-contact.png` 几乎全黑空图。

**根因（会话内 agent 实证推断，证据：diagnostics/ 轮廓 / 贴图 / Lambert 渲染对照）**：
① 软渲染器只取 `baseColorFactor` 不采样贴图，Meshy 烘焙导出材质 metallic=1 时
漫反射归零 → 黑屏；② 蒙皮资产的 mesh 挂在 0.01 缩放的 Armature 节点下，渲染器
无蒙皮 / 骨骼变换支持，实际绘制的是 ~1.7cm 微缩物体 + 固定俯视相机 → 空图；
③ clay 渲染方向倒置疑与 Armature 变换 / 相机 up 向量处理有关（未完全定位）。

**影响**：CLI / headless 侧的 `gen3d_render_preview` 对绑骨后资产不可用、对蒙皮
资产观感错误；web 会话「3D 资产」视窗（three.js）不受影响。

**规避**：用 web 视窗查看最终效果；或对未蒙皮的基础资产出预览。

**后续计划**：软渲染器渲染前按绑定姿态（或首帧姿态）烘焙顶点位置、支持贴图
采样、修正方向；或评估 preview 改走 three.js headless（node-canvas / headless-gl
成本需评估）。

## 16. playable export 合并阶段 `motion_read_failed: Invalid glTF 2.0 binary`

**现象（2026-08-25 真实环境复跑）**：`gen3d_export_playable_character` 在服务端
合并阶段抛 `motion_read_failed: Invalid glTF 2.0 binary`；同字节 GLB 用本地
gltf-transform NodeIO 逐个解析全部正常，重试同错。profile 安装副本与仓库 `lib/`
完全一致（`diff -rq` 无差异）。

**定位线索（会话内 agent 实证）**：merge 路径使用
`io.setVertexLayout(VertexLayout.SEPARATE)`，错误在该路径抛出；疑与 SEPARATE 布局
下蒙皮属性（JOINTS/WEIGHTS）处理有关，未完全定位。

**影响**：官方 export 通道在真实环境不可用；`gen3d_adopt_playable_character`
（adopt 路径）产出等价交付物（merged.glb + playable.json），本次交付即走该路径。

**后续计划**：在真实宿主环境最小复现（同字节 GLB + 服务端 merge 路径），定位
VertexLayout.SEPARATE 下的具体抛错点；修复后删除本条目。
