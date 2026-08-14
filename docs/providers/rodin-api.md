# Rodin / Hyper3D（影眸科技 Deemos）官方 API 协议文档（DSH 迁移参考）

> 本文档全部内容基于 Hyper3D 官方文档（developer.hyper3d.ai）与官网（hyper3d.ai）实际抓取整理，不含任何第三方网关（fal / WaveSpeedAI / ModelRunner 等）包装字段。官方文档为英文，本文为中文转述 + 字段直译。
> 抓取日期：2026-08-13。
>
> 来源 URL（均为官方）：
> - 文档站首页：https://developer.hyper3d.ai/
> - 认证/快速开始：https://developer.hyper3d.ai/get-started/readme-1
> - 最小示例（完整轮询流程）：https://developer.hyper3d.ai/get-started/minimal-example
> - API 概览（模型对比表）：https://developer.hyper3d.ai/api-specification/overview_reset_v
> - Gen-1&1.5 生成：https://developer.hyper3d.ai/api-specification/rodin-generation_reset_v
> - Gen-2 生成：https://developer.hyper3d.ai/api-specification/rodin-generation-gen2_reset_v
> - Gen-2.5 生成：https://developer.hyper3d.ai/api-specification/rodin-gen2.5
> - Bang（模型拆分）：https://developer.hyper3d.ai/api-specification/bang_reset_v
> - Check Status：https://developer.hyper3d.ai/api-specification/check-status_reset_v
> - Download Results：https://developer.hyper3d.ai/api-specification/download-results_reset_v
> - Check Balance：https://developer.hyper3d.ai/api-specification/check_balance_reset_v
> - Generate Texture：https://developer.hyper3d.ai/api-specification/generate-texture_reset_v
> - 文档索引：https://developer.hyper3d.ai/llms.txt
> - 数据保留策略：https://developer.hyper3d.ai/legal/data-policy.md
> - 价格页：https://hyper3d.ai/pricing
> - 官网首页（营销说法）：https://hyper3d.ai/

---

## 0. 总览

- 供应商：影眸科技（DeemosTech），产品线 **Hyper3D**（Rodin 文生/图生 3D + ChatAvatar 数字人面部）。
- 开放平台入口：**hyper3d.ai**（官网，注册账号、订阅套餐、创建 API Key 都在这里）。遗留域名 **hyperhuman.deemos.com** 已并入 hyper3d.ai 产品线（2026-08-13 实测访问返回 Hyper3D 官网页面；官方隐私/条款链接仍指向 `hyperhuman.deemos.com/legal/*`，OpenAPI spec 的 `info.title` 仍是旧名 "Hyper Human"）。
- Base URL：`https://api.hyper3d.com/api/v2`（创建/轮询/下载/余额均为该前缀下的独立端点，见 §2/§4/§5）。
- 认证：`Authorization: Bearer <API Key>`（见 §1）。
- 任务模型：**异步任务制**。POST 创建任务（**multipart/form-data，图片以字节直传**，不接受图片 URL）→ 立即返回任务 `uuid` + `jobs.subscription_key` → 用 `subscription_key` POST 轮询状态 → 全部 job 到终态后，用 `uuid` 换取下载 URL 列表 → 逐个下载。官方最小示例轮询间隔 **5 秒**。
- 任务状态机（无任务级 status，只有 **job 级** status）：`Waiting`（排队）→ `Generating`（执行）→ `Done` / `Failed`。一个任务含多个 job（如几何 + 贴图），**必须全部 job 为终态**才算完成（官方示例：`all(s['status'] in ['Done','Failed'] ...)`）。
- 与 Meshy/Hunyuan 的关键差异：
  1. **创建请求是 multipart/form-data 文件直传**，不是 JSON + URL；provider 侧需先把本地图片读出字节再作为 form 字段上传。
  2. **API 使用有订阅门槛**：官方错误 `SUBSCRIPTION_PLAN_TOO_LOW` 明确 "Business subscription is required to use Rodin API"；定价页显示 **API access 仅 Business 档（$120/月）起**。
  3. 图片输入多视图**最多 5 张**，form-data 保序，**第一张图固定用于材质生成**。
- 数据保留：官方数据策略承诺数据安全存储 **7 天**、不用于训练、不经同意不共享；**API 生成的模型不会出现在用户网页端 ASSETS 标签页**。拿到下载 URL 后应立即下载。
- 计费：credits 积分制，生成类 0.5–1.0 credits/次，状态/下载/余额查询免费（详见 §7）。

curl 约定：官方文档所有 curl 均为 bash + `-F`（multipart）或 JSON POST 风格，本文按官方原样转写。

---

## 1. 认证方式（API Key）

官方文档（[Get started with Rodin](https://developer.hyper3d.ai/get-started/readme-1)）：

1. **必须拥有 Business 及以上订阅**才能请求 API（文档开头原文："You must have a Business subscription to request this API. If you have not yet subscribed, go here to subscribe."）。
2. 登录 Rodin 账号（hyper3d.ai）→ 进入 **API Key Management 页面** → 点击 "+Create new API Keys" 创建。
3. key **只显示一次**，创建后立即复制保存；丢失需重新生成；可在同一页面随时吊销、可建多个 key。
4. 每个请求带 `Authorization: Bearer <API_KEY>` 头（Bearer 前缀必须）。

> 官方文档**未记载** key 的字符串格式（不像 Meshy 有社区流传的 `msy-` 前缀；本机 2026-08-13 抓取时官方示例统一用占位符 "your api key"）。

curl 验证（官方示例为 `GET /api/v2/check_balance`）：

```bash
curl --location 'https://api.hyper3d.com/api/v2/check_balance' \
  --header 'Authorization: Bearer RODIN_API_KEY'
# => {"balance": 12}
```

---

## 2. 生成端点：`POST /api/v2/rodin`（文生 3D / 图生 3D / 多视图）

**唯一生成入口**。靠「是否上传 `images` 文件」自动选择模式；靠 `tier` 选择模型版本（Gen-1&1.5 系列 / Gen-2 / Gen-2.5 系列）。

### 2.1 模式选择（自动判定）

| 模式 | 触发条件 | 说明 |
|---|---|---|
| Text-to-3D | **不传任何** `images` | `prompt` 必填；显式说明 "No image files should be uploaded when using Text-to-3D mode" |
| Image-to-3D（单图） | 传 1 个 `images` | `prompt` 可选；不传时模型根据图片自动生成 prompt |
| Image-to-3D（多视图/多物体） | 传 2–5 个 `images` | Gen-1&1.5 需显式 `condition_mode`；Gen-2/2.5 自动按多视图处理 |

- 图片**最多 5 张**；form-data 保留上传顺序，**第一张图用于材质（material）生成**。
- Gen-1&1.5 多图两种模式（`condition_mode`）：`concat`（默认，同一物体的多视角，顺序无关）/ `fuse`（多物体的特征融合生成）。
- Gen-2 / Gen-2.5 多图自动视为同一物体的多视角（无 `condition_mode`）；Gen-2.5 额外支持 `image_label` 逐张标注朝向（F/FL/FR/L/R/B/BL/BR/U/D/?）。

### 2.2 请求参数（公共表）

**Content-Type 必须为 `multipart/form-data`**（官方明确："All requests to this endpoint must be sent using `multipart/form-data` to properly handle the file uploads"）。布尔/数字/数组参数以 form 字符串形式传（数组如 `addons=HighPack` 可重复或单值；`bbox_condition=[100,100,100]` 传 JSON 数组字符串）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `images` | file/Binary | — | 参考图，≤5 张；第 1 张用于材质生成 |
| `prompt` | string | — | 文生 3D 必填；图生 3D 可选（缺省由模型看图生成） |
| `tier` | string | `Regular` | 模型档位：`Sketch`/`Regular`/`Detail`/`Smooth`（Gen-1&1.5 系列）、`Gen-2`、`Gen-2.5-Extreme-Low`/`Gen-2.5-Low`/`Gen-2.5-Medium`/`Gen-2.5-High`/`Gen-2.5-Extreme-High`（见 §3） |
| `use_original_alpha` | bool | `false` | `true` 时使用图片原始透明通道 |
| `condition_mode` | string | `concat` | **仅 Gen-1&1.5**：`concat`（单物体多视角）/ `fuse`（多物体特征融合） |
| `seed` | number | 随机 | 随机种子，0–65535（含两端） |
| `geometry_file_format` | string | `glb` | `glb`/`usdz`/`fbx`/`obj`/`stl` |
| `material` | string | `PBR` | `PBR`（base color+metallic+normal+roughness）/ `Shaded`（仅烘焙光照 base color）/ `All`（两者都给）/ `None`（无材质；Gen-2.5 文档列 PBR/Shaded/All，Gen-1&1.5 与 Gen-2 文档含 None） |
| `quality` | string | `medium` | 面数档位 `high`/`medium`/`low`/`extra-low`，具体面数随 tier 与 `mesh_mode` 变化（§3 表） |
| `quality_override` | number | — | 自定义面数，设置后 `quality` 失效；取值范围随 tier 与 `mesh_mode`（§3 表）；⚠ 覆盖后需自行保证在该 tier 能力内 |
| `TAPose` | bool | `false` | 人形模型强制生成 T pose 或 A pose（绑骨就绪姿态） |
| `bbox_condition` | Array[int] | — | BoundingBox ControlNet：`[宽(Y轴), 高(Z轴), 长(X轴)]` 3 个整数，控制生成物最大包围盒 |
| `mesh_mode` | string | `Quad`（Gen-2.5 为 `Raw`） | `Raw` 三角面 / `Quad` 四边面；Gen-1&1.5 与 Gen-2 默认 `Quad`，**Gen-2.5 默认 `Raw`** |
| `mesh_simplify` | bool | `true` | **仅 Gen-1&1.5**，且 `mesh_mode=Raw` 时生效：生成后简化 |
| `mesh_smooth` | bool | `false` | **仅 Gen-1&1.5**，且 `mesh_mode=Quad` 时生效：平滑（类似 Gen-1 效果） |
| `addons` | string[] | `[]` | 仅 `HighPack`：4K 贴图（默认 2K）；`Quad` 模式下目标面数 ×~16 产出高模 |
| `preview_render` | bool | `false` | `true` 时下载列表额外提供高质量渲染图 |
| `hd_texture` | bool | `false` | **仅 Gen-2/2.5**：后处理精修增强贴图（可能降低与输入图相似度） |
| `texture_delight` | bool | `false` | **仅 Gen-2.5**：预处理去除贴图中的光照信息 |
| `texture_mode` | string | — | **仅 Gen-2.5**：`legacy`/`extreme-low`/`low`/`medium`/`high`，档位越高质量越好耗时越长 |
| `is_micro` | bool | `false` | **仅 Gen-2.5-Extreme-High**：微细节尺度 |
| `geometry_instruct_mode` | string | `faithful` | **仅 Gen-2.5**：`faithful`（忠实输入）/ `creative`（创造性，仅 Medium/High/Extreme-High 档可用） |
| `image_label` | string[] | `[]` | **仅 Gen-2.5**：逐张输入图的朝向标签，`F`/`FL`/`FR`/`L`/`R`/`B`/`BL`/`BR`/`U`/`D`/`?`，顺序须与上传顺序一致 |

### 2.3 响应与错误

成功（HTTP 201）：

```json
{
  "error": null,
  "message": "Submitted.",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "jobs": {
    "uuids": ["job-uuid-1", "job-uuid-2"],
    "subscription_key": "sub-key-1"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `error` | string/null | 成功为 `null`；失败为错误码字符串（见下表） |
| `message` | string | 成功 "Submitted."；失败时的人类可读详情 |
| `uuid` | string | **任务**唯一标识，后续 Download 用 |
| `jobs.uuids` | string[] | 子任务 uuid 列表（几何 job、贴图 job 等） |
| `jobs.subscription_key` | string | 轮询状态用的订阅键 |

> ⚠ Gen-2.5 文档特别提示：Check Status / Download 一律用顶层 **`uuid`**（Download 的 `task_uuid`），**不要用 `jobs.uuids`**。

创建即失败的错误码（`error` 字段取值，所有生成类端点通用）：

| error | 含义 |
|---|---|
| `NO_ACTIVE_SUBSCRIPTION` | 无有效订阅，或订阅已过期 |
| `SUBSCRIPTION_PLAN_TOO_LOW` | 需 Business 订阅才能用该 API（Gen-1/1.5、Gen-2、Gen-2.5、Bang 各自的错误文案均如此） |
| `INSUFFICIENT_FUND` | 账号余额不足 |
| `INVALID_REQUEST` | 请求畸形/缺参/参数非法（看 `message`） |
| `USER_NOT_FOUND` | API Key 无效或用户不存在 |
| `GROUP_NOT_FOUND` | API Key 无效或 group 不存在 |
| `PERMISSION_DENIED` | 已认证但无权限执行该操作 |
| `UNKNOWN` | 意外错误（看 `message`） |

### 2.4 curl 示例（均来自官方文档）

最小图生 3D（Gen-2.5 前的默认档 Regular）：

```bash
export RODIN_API_KEY="your api key"
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "images=@/path/to/your/image.jpg"
unset RODIN_API_KEY
```

文生 3D：

```bash
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "prompt=A 3D model of a futuristic robot"
```

多视图图生 3D（Gen-1&1.5，concat）：

```bash
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F 'condition_mode=concat' \
  -F "images=@/path/to/your/image_0.jpg" \
  -F "images=@/path/to/your/image_1.jpg"
```

Gen-2 全参数（官方示例）：

```bash
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "images=@/path/to/your/image.jpg" \
  -F "tier=Gen-2" \
  -F "prompt=A 3D model of a futuristic robot" \
  -F "mesh_mode=Raw" \
  -F "seed=42" \
  -F "geometry_file_format=fbx" \
  -F "material=PBR" \
  -F "quality_override=500000"
```

Gen-2.5 常规模式（官方示例）：

```bash
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "images=@/path/to/your/image.jpg" \
  -F "tier=Gen-2.5-Medium" \
  -F "mesh_mode=Raw" \
  -F "quality_override=500000" \
  -F "texture_mode=high" \
  -F "geometry_instruct_mode=creative"
```

BoundingBox ControlNet：

```bash
curl https://api.hyper3d.com/api/v2/rodin \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "bbox_condition=[100,100,100]" \
  -F "prompt=A sofa."
```

---

## 3. 模型版本（tier）对照

### 3.1 版本总览（官方 Overview 能力对比表）

| 模型 | 定位 | 生成时长 | 特性 |
|---|---|---|---|
| **Gen-2** | 最先进生成模型（BANG 架构，10B 参数） | ~90 秒 | 可调面数、高质量贴图（Base Pack 为 2K）；HighPack：4K 贴图 + Quad 高模 |
| **Sketch** | 快速低模原型 | ~20 秒 | 基础几何 + **1K 贴图**、简单 UV、低模；**仅三角面 GLB** |
| **Regular** | 常规生成 | ~70 秒 | 可调面数、高质量贴图（2K）；HighPack 同上 |
| **Detail** | 细节增强 | >70 秒 | 同上 |
| **Smooth** | 更清晰锐利 | >70 秒 | 同上 |

- Gen-2 官方概述特性：几何质量 ×4 提升、递归部件化生成（BANG）、**baked normals**（低模呈现高模细节）、HD 贴图；"将在 2025 年逐步通过 API 开放"。
- Gen-2.5（官网营销说法，非 API 文档）：几何 ~4 秒、整模 ~5 秒、支持 10M+ 多边形、3D 原生贴图。API 文档**未记载** Gen-2.5 生成时长。

### 3.2 `quality` 面数档位（官方文档逐版本数值）

| tier | mesh_mode | high | medium | low | extra-low | 默认 |
|---|---|---|---|---|---|---|
| Gen-1&1.5（Regular 等） | Quad | 50k | 18k | 8k | 4k | medium |
| Gen-1&1.5 | Raw | —（固定 medium，见下注） | | | | |
| Gen-2 | Raw | 500k | 150k | 20k | 2k | high |
| Gen-2 | Quad | 50k | 18k | 8k | 4k | medium |
| Gen-2.5 | Raw | 1M | 500k | 60k | 20k | medium |
| Gen-2.5 | Quad | 50k | 18k | 8k | 4k | medium |

> 注：Gen-1&1.5 在 `mesh_mode=Raw` 时 `quality` 固定为 medium、`addons` 强制 `[]`；Sketch 档 `quality` 固定 medium 且 `quality_override` 不生效。

### 3.3 `quality_override` 范围（官方文档逐版本数值）

| tier | mesh_mode | quality_override 范围 |
|---|---|---|
| Gen-1&1.5 | 任意 | 2,000 – 200,000（文档未按 mesh_mode 区分） |
| Gen-2 | Raw | 500 – 1,000,000（默认 500,000；文档建议 Gen-2 **150,000+ 面**） |
| Gen-2 | Quad | 1,000 – 200,000（默认 18,000） |
| Gen-2.5 | Quad | 1,000 – 200,000 |
| Gen-2.5 | Raw + Gen-2.5-High / Extreme-High | 20,000 – 2,000,000 |
| Gen-2.5 | Raw + 其他档 | 500 – 1,000,000 |

Gen-2.5 官方还定义了三种生成模式：

| 模式 | 可用 tier | 面数范围 | 要点 |
|---|---|---|---|
| Regular | Gen-2.5-Low/Medium/High | 1,000 – 1,000,000 | 均衡质量与速度，支持 Creative 模式 |
| Fast | Gen-2.5-Extreme-Low/Low/Medium/High | 1,000 – 20,000 | 快速原型，格式受限 |
| Extreme-High | Gen-2.5-Extreme-High | 20,000 – 2,000,000 | 超高网格质量，`is_micro` 选项 |

### 3.4 Gen-2.5 档位与价格（官方 Gen-2.5 文档）

| tier | 说明 | 消耗 |
|---|---|---|
| `Gen-2.5-Extreme-Low` | 快速生成简单资产 | 0.5 credit |
| `Gen-2.5-Low` | 干净资产/小型硬表面道具 | 0.5 credit |
| `Gen-2.5-Medium` | 中等复杂度模型 | 0.5 credit |
| `Gen-2.5-High` | 高质量资产，推荐 | 0.5 credit |
| `Gen-2.5-Extreme-High` | 高频细节还原 | 1.0 credit |

---

## 4. 任务轮询 / 下载 / 余额

### 4.1 Check Status：`POST /api/v2/status`

请求体：`{"subscription_key": "<创建响应里的 subscription_key>"}`。

响应：

```json
{
  "jobs": [
    { "uuid": "123e4567-...", "status": "Generating" }
  ]
}
```

`status` 取值（job 级）：

| status | 含义 |
|---|---|
| `Waiting` | 已入队等待调度 |
| `Generating` | worker 正在生成 |
| `Done` | 完成，可调用 Download |
| `Failed` | 失败，需联系官方支持获取详情 |

- 免费调用（官方明示不额外扣 credits）。
- ⚠ 官方文档警告："请勿过于频繁调用此 API（会给服务器带来额外压力），**过频的请求可能被限流（throttle）**"。官方最小示例的轮询间隔为 **5 秒**。
- 无任务级聚合 status：任务是否完成须由 `jobs[]` 全部进入终态（Done/Failed）判定；任一 job Failed 即任务失败。

curl：

```bash
curl -X 'POST' 'https://api.hyper3d.com/api/v2/status' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -d '{"subscription_key": "your-subscription-key"}'
```

### 4.2 Download Results：`POST /api/v2/download`

请求体：`{"task_uuid": "<创建响应里的 uuid>"}`（**任务 uuid，不是 job uuid**）。

响应：

```json
{
  "error": "OK",
  "list": [
    { "url": "https://...", "name": "model_xxx.glb" },
    { "url": "https://...", "name": "preview.webp" }
  ]
}
```

- `list[]` 为文件级条目：`url` 下载地址 + `name` 可读文件名；官方文档确认下载列表中会有 `preview.webp` 可用于预览模型。
- **任务未到 Done 就调用可能返回不完整列表**（官方原话："may return unexpected results like incomplete list of files"），必须先轮询到终态。
- 免费调用；拿到 URL 应立即下载（数据仅保留 7 天，见 §0）。

curl（官方示例，含 jq 批量下载）：

```bash
curl -X 'POST' 'https://api.hyper3d.com/api/v2/download' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -d '{"task_uuid": "your-task-uuid"}' | \
   jq -r '.list[] | "\(.url) \(.name)"' | \
   while read url name; do
     curl -o "$name" "$url"
   done
```

### 4.3 Check Balance：`GET /api/v2/check_balance`

```bash
curl --location 'https://api.hyper3d.com/api/v2/check_balance' \
  --header 'Authorization: Bearer RODIN_API_KEY'
# => {"balance": 12}
```

- 返回 `{"balance": <int>}` 剩余积分；免费调用。
- 官方**没有**消费明细/历史端点（官方文档未记载）。

---

## 5. 其他端点：Bang（模型拆分）与 Texture Only（贴图生成）

### 5.1 Bang：`POST /api/v2/bang`（0.5 credits/次）

把 Rodin 生成物（或用户自传模型）**拆分为多个子部件**（官网称 Iterative Splitting，适合把"角色+装备"复合模型拆开）。**`asset_id` 与 `model` 互斥，二选一**：

| 场景 | 参数 | 说明 |
|---|---|---|
| 拆 Rodin Gen-2 任务 | `asset_id` | 传生成任务返回的 task `uuid`；`model`/`image`/`prompt` 必须留空（传了也会被忽略） |
| 拆自定义模型 | `model` | 文件，支持 `obj`/`glb`/`stl`/`fbx`/`usd`/`usda`/`usdz`/`usdc`；须搭配 `image`（≤1 张，≤100MB，作贴图参考）和/或 `prompt` |

公共参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `strength` | number | `5` | 拆分强度 2–12，越大拆得越多 |
| `geometry_file_format` | string | `glb` | **必填**：`glb`/`obj`/`fbx`/`stl`/`usdz` |
| `material` | string | `PBR` | `PBR`/`Shaded`/`None`/`All` |
| `resolution` | string | `Basic` | `Basic`=2K / `High`=4K 贴图 |

curl（拆 Rodin 任务）：

```bash
curl https://api.hyper3d.com/api/v2/bang \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "asset_id=YOUR_UUID" \
  -F "strength=5" \
  -F "geometry_file_format=glb" \
  -F "material=PBR" \
  -F "resolution=Basic"
```

响应结构与生成端点相同（`uuid` + `jobs.uuids` + `jobs.subscription_key`），后续同样走 status/download。错误码同 §2.3（Bang 页错误文案为 "Business subscription is required to use Rodin Bang! API"）。

### 5.2 Texture Only：`POST /api/v2/rodin_texture_only`（0.5 credits/次）

给已有模型重新生成贴图（参考图驱动）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `image` | file/Binary | 是 | 1 张贴图参考图 |
| `model` | file/Binary | 是 | 3D 模型文件，**≤10MB** |
| `prompt` | string | 否 | 贴图描述 |
| `seed` | number | 否 | 0–65535 |
| `reference_scale` | number | 否 | 纹理生成参考尺度 |
| `geometry_file_format` | string | 否 | `glb`（默认）/`usdz`/`fbx`/`obj`/`stl` |
| `material` | string | 否 | `PBR`（默认）/`Shaded` |
| `resolution` | string | 否 | `Basic`（默认，2K）/`High`（4K） |

curl：

```bash
curl https://api.hyper3d.com/api/v2/rodin_texture_only \
  -H "Authorization: Bearer ${RODIN_API_KEY}" \
  -F "image=@/path/to/your/image.jpg" \
  -F "model=@path/to/your/model.obj" \
  -F "reference_scale=1.0" \
  -F "geometry_file_format=glb" \
  -F "material=PBR" \
  -F "resolution=High"
```

> 该端点可作"给低模重贴图"的管线（配合 §6 的低模生成），是官方 API 中唯一接受外部模型文件的生成类端点（另有 Bang 的 `model` 入参）。

---

## 6. 绑骨 / 动画 / 低模 / 重拓扑能力核对

| 能力 | 官方 API | 说明 |
|---|---|---|
| 自动绑骨 | ❌ **无** | API 文档全目录（llms.txt）只有生成 / Bang / status / download / check_balance / texture_only 6 类端点；第三方网关（fal、WaveSpeedAI 等）也只暴露文生/图生 3D，均无绑骨端点 |
| 动画/动作库 | ❌ **无** | 同上；无动作目录、无套动作接口。与 Meshy（Rigging + Animation + 690 条动作目录）、Hunyuan（绑骨 + 48 预设动作 + 文生动作）形成明显差异 |
| 绑骨就绪姿态 | ✅ 间接 | `TAPose=true` 生成 T/A pose 人形；配合 `mesh_mode=Quad`（四边面）产出对下游绑骨友好的输入。原插件"绑骨"环节无法由 Rodin 完成 |
| 低模 | ✅ 生成时控制 | `quality`/`quality_override` 低面数档、`Sketch` tier（快速低模，1K 贴图）、`Raw` + `mesh_simplify`（Gen-1&1.5）。官网另宣传 "Smart Low-Poly"（Creator 档功能），**官方 API 文档未记载对应端点** |
| 重拓扑 | ⚠️ 无独立端点 | 无后处理重拓扑 API（对比 Hunyuan 有 SmartTopology、Meshy 有 Remesh）。近似能力：生成时 `Quad` 模式直接产出规整四边面；Gen-2 的 **baked normals** 特性可在低模上呈现高模细节（官方概述） |
| 模型拆分 | ✅ **Bang** | `POST /api/v2/bang`（§5.1）——原插件"角色拆分"需求可部分由官方替代 |
| 贴图重生成 | ✅ **Texture Only** | `POST /api/v2/rodin_texture_only`（§5.2） |

> 结论：Rodin 在 DSH 四供应商中**只覆盖生成环节**。需要绑骨/动作的能力面必须继续依赖 Meshy（rigging/animation）或 Hunyuan（绑骨/文生动作）；Rodin 的职责是文生/图生/多视图生成 + T/A pose + 四边面（绑骨就绪输入）＋ 拆分/重贴图辅助。

---

## 7. 配额 / 价格 / 限速 / 错误码

### 7.1 价格（hyper3d.ai/pricing，2026-08-13 抓取）

| 套餐 | 价格 | 内容 |
|---|---|---|
| Free | $0 | 按结果付费（网页端先预览后确认扣费）；**无 API access**；直购 credits $1.5/credit |
| Creator | $30/月（年付 $24/月） | 约 60 个模型/月；多图生 3D、Smart Low-Poly、HD/自定义贴图、baked normals、更多面数选项；**无 API access** |
| Business | $120/月（年付 $96/月） | 约 416 模型/月；**Full API access**、4K 贴图 + High-Poly Quad、120 RPM（前三个 tier）/ 240 RPM（更高 tier） |
| Enterprise | 定制 | 私有化部署、自定义 LoRA/微调、批量折扣 |

FAQ 补充：订阅 credits 每计费周期刷新；直购 credits 单价更高但有效期更长。

### 7.2 API 单次消耗（官方各端点文档明示）

| 端点 | 消耗 |
|---|---|
| `/api/v2/rodin` 生成（Gen-1&1.5 / Gen-2 / Gen-2.5 除 Extreme-High） | **0.5 credit/次** |
| `/api/v2/rodin` 生成（Gen-2.5-Extreme-High） | **1.0 credit/次** |
| addon `HighPack` | **+1 credit/次** |
| `/api/v2/bang` | 0.5 credit/次 |
| `/api/v2/rodin_texture_only` | 0.5 credit/次 |
| `/api/v2/status` / `/api/v2/download` / `/api/v2/check_balance` | 免费 |

> 官方明确："**参数本身不额外收费**，只有 addon 计费"（There are no additional fees for parameters. Only addons incur extra charges）。

### 7.3 限速

- 官方公开的量化限速仅有定价页的 **RPM（每分钟请求数）**：Business 档前三个 tier 120 RPM、更高 tier 240 RPM（Enterprise 定制）。
- status 端点文档警告过频调用**会被限流**（"We may throttle some requests that are sent too frequently"），未给出阈值。
- **未记载**并发任务数上限、以及 HTTP 429 的响应体格式。

### 7.4 错误码汇总

- **请求级（业务）错误**：生成类端点把错误放在 JSON 的 `error` 字段（201 响应的正常形态是 `error: null`），取值见 §2.3 表。与 Meshy（HTTP 状态码 + message 字段）不同，**多数业务错误不靠 HTTP 状态区分**。
- **HTTP 状态码**：官方文档只记载了 201（创建成功）；401/403/429/5xx 等 HTTP 级语义**未记载**（如实标注：实现时按通用约定处理并留日志）。
- **任务级失败**：轮询到 `status: Failed` 即失败，官方未提供任务级错误码字段，文档建议联系支持获取详情。

### 7.5 映射到 DSH `provider_*` 错误码（建议）

| Rodin error | DSH 错误码 | 说明 |
|---|---|---|
| `USER_NOT_FOUND` / `GROUP_NOT_FOUND` | `provider_unauthorized` | Key 无效 |
| `NO_ACTIVE_SUBSCRIPTION` / `SUBSCRIPTION_PLAN_TOO_LOW` / `PERMISSION_DENIED` | `provider_unauthorized` | 订阅门槛/无权限（可提示"需 Business 订阅"） |
| `INSUFFICIENT_FUND` | `provider_insufficient_credits` | 余额不足，预检 `check_balance` 可提前发现 |
| `INVALID_REQUEST` | `provider_bad_request` | 参数非法，看 message 修正 |
| HTTP 429 / throttle | `provider_rate_limited` | 限频退避（轮询被限流时拉长间隔） |
| `UNKNOWN` / HTTP 5xx | `provider_http_error` | 重试 |
| `status=Failed`（任务级） | `provider_http_error`（带原始 status 上下文） | 官方不提供细分原因 |

---

## 8. 对 DSH 迁移的关键结论

1. **凭证**：`RODIN_API_KEY`（官方示例即用此变量名）→ `src/config.ts` 的 `readProviderKey('rodin')`。**注意订阅门槛**：未配置 key 与"配置了但非 Business 订阅"都要回退确定性 mock，后者可从 `error=SUBSCRIPTION_PLAN_TOO_LOW` 识别并在状态界面提示。
2. **传输形态**：创建类请求全部是 **multipart/form-data**——图片字节直传、布尔/数字转字符串 form 字段；DSH provider 实现需用 `fetchImpl` + `FormData`（Node 18+ 原生支持），单测 mock 时断言 form 字段与文件字节即可。**官方不支持图片 URL 输入**（与 Meshy 的 `image_url` 相反）；本包实现的做法（先下载上传图字节再 attach）与官方协议一致。
3. **任务协议**：create（拿 `uuid` + `subscription_key`）→ 每 **5 秒** poll `/api/v2/status`（用 `subscription_key`，全部 job 终态才完成；任一 Failed 即失败）→ `/api/v2/download`（用顶层 `uuid`）→ 逐个下载 `list[]`。对应 DSH `ctx.jobs` 长任务模型；下载文件按 `name` 归类（模型主文件 + `preview.webp` 可作缩略图）。
4. **模型选择**：默认 `tier=Regular`（Gen-1&1.5）；游戏角色建议 `tier=Gen-2` 或 Gen-2.5-Medium/High + `TAPose=true` + `mesh_mode=Quad`（四边面）+ `material=PBR` + `geometry_file_format=glb`（本包参数白名单：tier/quality/mesh_mode/material/quality_override 与官方字段一一对应）。`quality_override` 范围随 tier/mesh_mode 变化，provider 需按版本 clamp。
5. **能力裁剪**：无绑骨/动画/重拓扑端点 → 原插件绑骨流程不指向 Rodin；`TAPose+Quad` 产出绑骨就绪输入，随后转交 Meshy/Hunyuan 绑骨；Bang 可拆分复合模型（替代部分本地拆分逻辑）；texture_only 可给外部模型补贴图。
6. **配额预检**：创建前 `GET /api/v2/check_balance`（免费、无并发负担）；`INSUFFICIENT_FUND` → `provider_insufficient_credits`。
7. **下载时效**：官方数据保留 **7 天**；`download` 在任务未完成时会返回不完整列表，必须先轮询到终态再取；URL 拿到即下载。API 资产不会出现在网页端 ASSETS。
8. **轮询纪律**：官方明示过频轮询会被限流；DSH 轮询间隔固定 5s（官方示例），遇到 throttle 迹象（429/重复限流）动态拉长。

---

## 9. 来源 URL 清单

**文档站（developer.hyper3d.ai，全部官方）**
- 文档站首页：https://developer.hyper3d.ai/
- 认证/快速开始：https://developer.hyper3d.ai/get-started/readme-1
- 最小示例：https://developer.hyper3d.ai/get-started/minimal-example
- API 概览：https://developer.hyper3d.ai/api-specification/overview_reset_v
- Gen-1&1.5 生成：https://developer.hyper3d.ai/api-specification/rodin-generation_reset_v
- Gen-2 生成：https://developer.hyper3d.ai/api-specification/rodin-generation-gen2_reset_v
- Gen-2.5 生成：https://developer.hyper3d.ai/api-specification/rodin-gen2.5
- Bang：https://developer.hyper3d.ai/api-specification/bang_reset_v
- Check Status：https://developer.hyper3d.ai/api-specification/check-status_reset_v
- Download Results：https://developer.hyper3d.ai/api-specification/download-results_reset_v
- Check Balance：https://developer.hyper3d.ai/api-specification/check_balance_reset_v
- Generate Texture：https://developer.hyper3d.ai/api-specification/generate-texture_reset_v
- 文档索引（llms.txt）：https://developer.hyper3d.ai/llms.txt
- 数据保留策略：https://developer.hyper3d.ai/legal/data-policy.md

**官网（hyper3d.ai）**
- 官网首页（Gen-2.5 营销数据、功能列表）：https://hyper3d.ai/
- 价格页（套餐/API access/RPM）：https://hyper3d.ai/pricing
- 遗留域名（已并入）：https://hyperhuman.deemos.com/ （隐私/条款：https://hyperhuman.deemos.com/legal/privacy 、https://hyperhuman.deemos.com/legal/terms ）

**工程内佐证（非外部来源）**
- 本包 `src/legacy/shared/catalog.ts`（rodin 条目记录的协议：POST /api/v2/rodin multipart、按 subscription_key 轮询 /api/v2/status、经 /api/v2/download 取 URL、tier=Regular / material=PBR / geometry_file_format=glb / quality_override 控面数，与官方文档一致）
- 本包参数白名单 `src/legacy/shared/provider-params.ts`（rodin: tier/quality/mesh_mode/material/quality_override，`verified: true`）

---

## 10. 已知缺口与风险（如实标注）

1. **HTTP 级错误码未记载**：官方文档只写了 201 成功与 JSON `error` 字段；401/403/429/5xx 的响应体格式与语义无文档，实现时需按通用约定容错并记日志。
2. **API 门槛高**：必须 Business 订阅（$120/月）——比 Meshy（任意注册即可建 key）成本结构差很多；DSH 中 Rodin 大概率是"可选增强"而非默认供应商。
3. **图片输入约束未完整记载**：官方只记载 Bang 的 `image` ≤100MB、texture_only 的 `model` ≤10MB；生成端点 `images` 的格式/分辨率/单文件大小限制**未记载**。
4. **限速量化未知**：并发任务上限、轮询限流阈值、429 行为均未公开；定价页的 120/240 RPM 是唯一量化指标。
5. **文档内部不一致**：Gen-2.5 页 Markdown 称 `geometry_instruct_mode` 默认 `creative`，而同一页引用的 OpenAPI YAML（`tmp_rodin_gen2_5.yaml`）默认值为 `faithful`；实现时显式传值，勿依赖默认。
6. **"任务级失败原因"不可得**：`status=Failed` 后官方不提供错误码字段，文档只建议联系支持；DSH 只能回显原始状态。
7. **官网新功能无 API**：Smart Low-Poly、Remix Gen、Turbo Gen、Partial Edit、Voxel/PointCloud ControlNet 等仅在官网/定价页出现，**官方 API 文档均未记载对应端点**；接入前需向官方确认是否已开放 API。
8. **生成时长数据不全**：Gen-1&1.5/Gen-2 有官方时长（20–90 秒级），Gen-2.5 只有官网营销口径（~4–5 秒），API 文档未记载；轮询超时预算按营销数据可能过乐观，建议按 90 秒级配置超时。
9. **价格可能变动**：套餐/credits 价格为 2026-08-13 官网快照；订阅 credits 每周期刷新、直购 credits 长期有效（官方 FAQ），采购前以控制台为准。
