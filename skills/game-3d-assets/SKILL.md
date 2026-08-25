---
name: game-3d-assets
description: 为 3D 游戏创建生产级资产（角色 / 道具 / 环境）的全流程规范与预算——当用户要做游戏资产、游戏角色、道具、场景件，或提到 Unity / Unreal / Godot / web3D 引擎时使用。
---

# Game 3D Assets

## When to use

- 用户要做**游戏资产**：英雄角色 / 道具 / 环境件（场景、建筑、载具等静态件），或明确提到 Unity / Unreal / Godot / Three.js 等 web3D 引擎
- 用户有引擎、平台、美术风格、面数预算等生产约束，需要按规范走完「生成 → 自检 → 评分 → 交付」闭环
- 一次只要一个静态展示角色、无生产约束的，走 `generate-3d-character`（轻量流程）；不接程序化 CAD、2D 素材

## Procedure

> **先问完全再动手**：开工前把下面几件事一次问完——不确认引擎 / 预算就生成是最大的浪费。

1. **专家引导（开工前必问，一次问完）**：
   - **目标引擎与平台**：Unity / Unreal / Godot / Three.js-web；桌面 / 移动 / 网页（移动端预算减半）
   - **美术风格**：写实 / 风格化 / 低模 / 体素
   - **资产类别**：英雄角色（hero-character）/ 道具（prop）/ 环境件（environment）——决定预算档与槽位
   - **面数与贴图预算**：用户无概念就按下表默认；有既定规格以用户规格为准，但超出预算档时要说明并确认
   - **是否需要绑骨与动作**（仅角色）：静态交付，还是 playable（骨架 + 动作 + 导出）
   - **交付格式**：默认 GLB（glTF Binary）；带骨架 / 动画的多文件交付会多给 `merged.glb` + `playable.json`

2. **预算规范**（与 `gen3d_inspect_asset` 三档严格一致；移动端整体减半）：

   | 档位 | 面数（≤，triangles） | 贴图分辨率（≤） | 材质数（≤） |
   | --- | --- | --- | --- |
   | hero-character | 30,000 | 2048 | 2 |
   | prop | 5,000 | 1024 | 2 |
   | environment | 50,000 | 2048 | 4 |

   - 面数是 **triangles 口径**（不是顶点数），贴图分辨率取资产内最大的一张
   - 低模 / 风格化：`providerParams: { model_type: 'smart-topology', ai_model: 'meshy-t2' }`，面数直接在工具参数 `targetPolycount` 给预算值（Meshy 请求体字段 `target_polycount`）；注意 meshy-t2 官方上限 15,000（超出自动钳制，不报错）——预算 30k 的英雄走低模路线实际产出 ≤15,000，仍合规

3. **管线路由决策**：
   - 有设定图 / 参考图：`gen3d_image_to_3d`（单视角）或 `gen3d_views_to_3d`（多角度，front 必填）——**有图就别弃图走文生**
   - 无设定图：`gen3d_text_to_3d` 先文生，再看结果决定是否精修
   - 角色要动作：生成时 `providerParams.pose_mode: 'a-pose'`（Meshy）；`enablePbr` 默认开（要贴图就别关）
   - Meshy 模型代际：缺省即 `latest`（现解析为 **Meshy 7** 代，最高细节几何）；要更精细表面加 `ultra_mode: true`（仅 meshy-7/latest、仅文生 preview/图生，+5 积分）；要省积分或保旧代行为显式 `ai_model: 'meshy-5' / 'meshy-6'`
   - 需要动作的角色：`gen3d_auto_rig` 绑骨（仅 `characters` 槽）→ `gen3d_list_motions` 查目录 → `gen3d_apply_motion`（一次一个动作、按动作幂等）→ playable 五工具（`gen3d_get_playable_profile` / `gen3d_set_playable_profile` / `gen3d_set_playable_motion_mapping` / `gen3d_export_playable_character` / `gen3d_adopt_playable_character`）导出游戏可用交付
   - 高模降面到预算：`gen3d_retopo_lowpoly`（`provider: 'meshy'`，官方 Remesh API，5 积分/次）——源资产保留、产出规整低面数新资产；适用 inspect 超面数或生成时未控面数的资产。**`targetPolycount` 口径注意**：Meshy 按拓扑面型计数——`polygonType: 'quadrilateral'`（默认）时按 quad 计，三角化后三角数 ≈ 2×（2026-08-25 实证：target 30,000 → 53,923 三角超标；target 14,000 → 26,550 三角合规）。hero 档 3 万三角预算给 ~14,000，或换 `polygonType: 'triangle'` 按三角直给
   - 道具 / 环境件：`assetSlot: 'meshes'`，不绑骨（软门控只认 characters 槽）

4. **验证闭环（每个资产必走）**：
   - `gen3d_inspect_asset` 对照预算档自检（面数 / 贴图 / 材质三科）——**违规要处理**：超面数首选 `gen3d_retopo_lowpoly`（`provider: 'meshy'`，本地资产直接可用——Meshy 资产自动取 sidecar 任务 id（或显式 `originalTaskId`），任意本地 GLB（含非 Meshy 资产）读文件直传，无需公网 URL；`targetPolycount` 按预算档给值，如 prop 档 ≤5000（与 `detailLevel` 互斥、给定优先），或 `detailLevel` 走 decimation_mode 减面档），重拓扑后再 `gen3d_inspect_asset` 复查；仍不达标才考虑重生成（走低模降档）或与用户确认放行，不许默认交付超标资产
   - `gen3d_render_preview` 渲染自检：web 用户去会话「3D 资产」页签**交互查看**（0.3.0 起支持 IBL 渲染、动画自动播放 / 暂停 / 切换 clip、图片资产内联预览——playable 交付后让用户在视窗里播动作验收）；CLI 用户回报**预览文件路径**（软渲染为视口级观感，不看引擎内最终效果）
   - 预览全黑先查材质：Meshy 烘焙导出 metallic 因子偏高时无环境光的渲染会死黑（web 视窗 0.3.0 起有 IBL 不受影响）；交付前可用 gltf-transform 本地把 metallic 调 0、roughness 调 ~0.75（零配额）
   - `gen3d_score_quality` 跑客观五维（geometry / topology / texture / pbr / prompt_fidelity），不达标由用户决定重生成或换 provider
   - `gen3d_rename_asset` 规范命名 → 交付：资产路径 + 规格摘要 + 预算对照结果

5. **效率与传参纪律**：
   - **如实转达配额消耗**：工具返回的 credits / 配额信息必须告诉用户，不隐瞒。常用档位速查（2026-08 官方定价，以工具 billing note 与官方 pricing 页为准）：文生两阶段 30（preview 20 + refine 10；meshy-5/meshy-t2 preview 仅 5）、图生/多视图有纹理 30（无纹理 20）、refine 10（8k 15）、remesh 5、绑骨 5、动作 3——一个「生成+绑骨+一个动作」的角色全链约 38 积分
   - 同参数重跑命中缓存（`cacheHit: true`）复用旧资产不重复烧配额——先看结果再决定要不要重试
   - `providerParams` 只放**白名单字段**（Meshy 如 `ai_model` / `model_type` / `target_polycount` / `pose_mode` / `should_remesh` / `decimation_mode` / `topology` / `origin_at`），无关字段会被过滤忽略，别指望透传私有字段
   - 长任务返回 `{ kind: 'background', jobId }` 句柄：用 `job_output` 查进度（平台没有 `job_read`）、`job_kill` 终止；轮询用 `wait: false` 短轮询（宿主会中止 `wait: true` 的长阻塞）
   - **网络瞬断恢复纪律**（0.3.0 起 provider 层已对幂等请求自动重试）：仍报 `网络请求失败 / fetch failed` 时，错误消息会带云端任务 id 与恢复指引——**不要盲目重发计费步骤**（会重复建单重复计费），按指引用 `originalTaskId` 类参数把云端已成功的成果接回（如 `gen3d_retopo_lowpoly` 的 `originalTaskId`）
   - 未配置 key 时全链路走确定性 mock（`usedMock: true`）——能跑通但**不是真实模型**，交付前必须提醒用户配 key

## Examples

- ✅ 「给 Unity 手游做一个 1.5 万面的低模武士」→ 问清平台（移动→减半档）→ smart-topology + targetPolycount=15000 → inspect 对照 hero-character 档 → render-preview → score-quality → rename 交付
- ✅ 「有设定图，把它做成 Unreal 里的墙体件」→ views-to-3d（有图优先）→ `assetSlot: meshes` → inspect 对照 environment 档 → 交付 + 文本指引
- ✅ 「让这个角色能走路」→ auto-rig → list-motions(query=walk) → apply-motion → playable 五工具导出 merged.glb + playable.json
- ❌ 没问引擎 / 预算就生成——超预算或风格不符，重来烧配额
- ❌ 工具提示 `usedMock: true` 还当真实资产交付
- ❌ 一个 asset 反复微调 prompt 烧配额——先 inspect + render-preview 定位问题（拓扑 / 贴图 / 朝向）再决定重生成还是精修

## Anti-patterns

- 不确认引擎 / 平台 / 预算档就直接生成——预算决定面数与贴图，跳过引导的产物大概率返工。
- 超预算交付——`gen3d_inspect_asset` 报了超标要处理（重生成 / 降档 / 用户确认），用户须知情。
- 把 mock 资产当真实交付——`usedMock: true` 的产物不是真模型，交付前必须提醒。
- 为一个资产反复微调 prompt 烧配额——先走 inspect + render-preview 定位具体问题，再决定重生成；同参数重跑先看是否 `cacheHit`。
- 给道具 / 环境件绑骨，或给角色套一个槽位外的动作——软门控会拒，别硬试。
- 计费信息不转达——工具给的 credits / 配额必须如实告知用户，涉及真金白银。
