# 已知能力缺口（dsh-gen3d）

> 状态：🟡 快照（2026-08-20，与 `src/` 代码现状对齐）。本文件逐条记录当前实现的
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

## 3. retopo-lowpoly 真实路径需公网源 URL（无 COS / 无模型上传链路）

**现状**：`gen3d_retopo_lowpoly` 的真实路径依赖：

- `hunyuan3d`（默认）：TC3 `Submit3DSmartTopologyJob`，需 `sourceUrl`——
  公网可达的源 GLB URL（官方约束，输入文件要公网 URL）；
- `tripo3d`：智能低模，需 `originalTaskId`——Tripo 侧带模型输出的任务 id。

本地资产既没有内置对象存储，也没有模型上传链路（Tripo `import_model` 未实现，
见 #2），所以**本地生成的资产做低模重拓扑，用户必须自备公网直链**（如自有
COS / OSS / 网盘直链）。mock 路径不需要 URL。

**影响**：从本地资产出发的 Hunyuan 智能拓扑，缺 `sourceUrl` 时报
`missing_source_url`；流程上比「生成→绑骨→动作」（Meshy 全程无需公网 URL）
多一步外部上传。

**规避**：把源 GLB 传到自有公网存储拿直链再提交；或先用 Tripo 生成资产（拿
`originalTaskId`）再走 Tripo 智能低模。

**后续计划**：Tripo `import_model` 落地后（#2），本地 GLB 可经上传链路直接走
Tripo 智能低模；Hunyuan 侧受官方「公网 URL 输入」约束，仍需要用户自备直链，
文档标注清楚。

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

## 10. 设置卡片的浏览器渲染未在真实 DSH web 部署端到端验证

**现状**：0.1.1 新增设置卡片（host 半边 `src/settings.ts` + 浏览器半边
`src/client/`，`tsdown.config.ts` 自复刻官方 clientBundle 输出格式）。已验证：
bundle 产物格式与官方发布面逐字一致（`window.__ModuleLoader__.load({ id:
"dsh-gen3d", factory: (require) => {...} })`，externals 仅平台模块 + runtime
store 引擎）、host/client 两套 tsc + tsdown 全绿、数据面单测（schema 缺省引用
与 `PROVIDER_ENV_KEYS` 一致性、控制器状态投影与写路径）通过。**未做**：把插件
装进带 Web UI 的 DSH 部署，实际打开设置页确认卡片渲染与读写。

**影响**：卡片依赖官方 keyed 槽 `settings.plugin.item` 与 `ctx.settingsScope`
服务（rc.7+ 发布面），且浏览器半边 bundle 格式是自复刻预设——未在真实浏览器
跑通前，这两处仍有理论偏差风险；host 半边与工具密钥接线（`providerEnvKeyOf`）
不依赖 Web 面，headless 部署不受影响。

**规避**：先用 `pnpm pack` + `dsh plugin add` 装进带 web 的 profile，打开
设置 → 插件配置页核对四行状态与引用读写；凭证状态以 `credentials.describe`
口径为准（Hunyuan3D TC3 路径不在凭证域，卡片只反映 `HUNYUAN3D_API_KEY`）。

**后续计划**：在真实 DSH web 部署完成冒烟后删除本条目。
