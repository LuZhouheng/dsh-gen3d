# Meshy 官方 API 协议文档（DSH 迁移参考）

> 本文档全部内容基于 Meshy 官方文档（docs.meshy.ai）实际抓取整理，不含任何第三方网关包装的字段。
> 抓取日期：2026-08-13。官方文档为英文，本文为中文转述 + 字段直译。
>
> 来源 URL（均为官方）：
> - API 总览：https://docs.meshy.ai/en/api/
> - 认证：https://docs.meshy.ai/en/api/authentication
> - Text to 3D：https://docs.meshy.ai/en/api/text-to-3d
> - Image to 3D：https://docs.meshy.ai/en/api/image-to-3d
> - Multi-Image to 3D：https://docs.meshy.ai/en/api/multi-image-to-3d
> - Rigging：https://docs.meshy.ai/en/api/rigging
> - Animation：https://docs.meshy.ai/en/api/animation
> - Animation Library（动作目录）：https://docs.meshy.ai/en/api/animation-library
> - Errors：https://docs.meshy.ai/en/api/errors
> - Rate Limits：https://docs.meshy.ai/en/api/rate-limits
> - Balance：https://docs.meshy.ai/en/api/balance

---

## 0. 总览

- Base URL：`https://api.meshy.ai`（请求体为 JSON，响应为 JSON；HTTPS 强制，HTTP 请求返回 301）。
- 认证：`Authorization: Bearer <API Key>` 头（见 §1）。
- 任务模型：**异步任务制**。POST 创建任务 → 立即返回 `202 Accepted`（响应体 `{"result": "<task_id>"}`）→ 轮询 GET 任务端点直到 `status: SUCCEEDED` → 从响应中的下载 URL 取资产。部分端点还支持 SSE 流式进度（`/stream`）。
- 通用任务状态机（所有任务类型一致）：`PENDING` → `IN_PROGRESS` → `SUCCEEDED` / `FAILED` / `CANCELED`。
- `progress` 字段 0–100；`started_at` / `created_at` / `finished_at` / `expires_at` 均为 **毫秒级 epoch 时间戳**（官方文档注明遵循 RFC 3339 表示法；未开始时为 0）。
- `consumed_credits`：任务消耗积分。PENDING/IN_PROGRESS/SUCCEEDED 时存在；FAILED 返回 0（**失败退费**）。
- 资产下载 URL 是带签名的临时 URL，有 `expires_at` 有效期（动画文档示例约 3 天，非企业账号资产约 3 天后删除——该 3 天说法来自 Meshy 官方技能/社区文档，API 文档本身以 `expires_at` 字段为准）。**拿到 URL 后应立即下载**。
- 任务列表分页：`page_num`（默认 1）、`page_size`（默认 10，最大 50）、`sort_by`（`+created_at` / `-created_at`）。
- 通过 API 创建的任务不会出现在网页端 "My Assets" 里，只能用 List 端点找回 task id。

curl 约定：下文所有 `curl` 均为官方文档风格（官方文档自带 curl 示例见 Animation / Balance 章节；Text/Image to 3D 页面示例为交互式 Playground 形式，curl 按官方一致风格编写）。

---

## 1. 认证方式（API Key）

官方文档（[Authentication](https://docs.meshy.ai/en/api/authentication)）：

1. 在 meshy.ai 官网注册账号（无 API key 请求会返回 invalid credentials 错误）。
2. 登录后打开 **API settings 页面**（官网 Settings → API），点击 Create API Key 并命名。
3. key 只显示一次，之后无法再查看；可随时吊销。可按用途建多个 key，用量分别统计。
4. 每个请求带 `Authorization: Bearer <API_KEY>` 头（Bearer 前缀必须，见 [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750)）。

> 官方文档**未记载** key 的字符串格式（社区普遍为 `msy-` 前缀，不作为依据）。

curl 验证：

```bash
curl https://api.meshy.ai/openapi/v1/balance \
  -H "Authorization: Bearer ${MESHY_API_KEY}"
# => {"balance": 1000}
```

---

## 2. Text to 3D（两阶段：preview + refine）

端点版本为 **v2**（其余能力多为 v1）。两阶段共用 `POST /openapi/v2/text-to-3d`，靠 `mode` 区分。

### 2.1 阶段一：创建 preview 任务（只出网格，无贴图）

`POST /openapi/v2/text-to-3d`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `mode` | string | 是 | — | 必须为 `"preview"` |
| `prompt` | string | 是 | — | 物体描述，最长 600 字符 |
| `model_type` | string | 否 | `standard` | `standard` 高细节；`lowpoly` 低模（选 lowpoly 时 `ai_model`/`topology`/`target_polycount`/`should_remesh` 被忽略） |
| `ai_model` | string | 否 | `latest` | `meshy-5` / `meshy-6` / `latest`(Meshy 6) |
| `should_remesh` | bool | 否 | `false`(meshy-6) / `true`(其他) | 是否启用 remesh 阶段；最高质量建议 false |
| `symmetry_mode` | string | 否 | `auto` | ⚠ 已废弃，不再影响输出（off/auto/on） |
| `pose_mode` | string | 否 | `""` | `a-pose` / `t-pose` / `""` 不指定 |
| `is_a_t_pose` | bool | 否 | `false` | ⚠ 已废弃，改用 `pose_mode` |
| `art_style` | string | 否 | `realistic` | ⚠ 已废弃，Meshy-6 不支持（realistic/sculpture） |
| `moderation` | bool | 否 | `false` | 内容安全审查（审查 prompt 文本） |
| `target_formats` | string[] | 否 | 全部 | 输出格式：`glb,obj,fbx,stl,usdz,3mf`；省略时除 `3mf` 外全出；`3mf` 必须显式指定才生成 |
| `alpha_thumbnail` | bool | 否 | `false` | 额外渲染透明背景 (RGBA) 缩略图 → `alpha_thumbnail_url` |
| `auto_size` | bool | 否 | `false` | AI 视觉自动估算真实高度并缩放；原点默认在底部 |

响应：`{"result": "<preview task id>"}`。

curl：

```bash
curl https://api.meshy.ai/openapi/v2/text-to-3d \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "preview",
    "prompt": "a cartoon knight character, full body",
    "pose_mode": "a-pose",
    "ai_model": "meshy-6",
    "target_formats": ["glb"]
  }'
# => {"result": "018b314a-..."}  (HTTP 202)
```

### 2.2 阶段二：创建 refine 任务（给 preview 网格上贴图）

`POST /openapi/v2/text-to-3d`，`mode: "refine"`，必须传 `preview_task_id`（其状态须为 SUCCEEDED）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `mode` | string | 是 | — | `"refine"` |
| `preview_task_id` | string | 是 | — | 已成功 preview 的任务 id |
| `enable_pbr` | bool | 否 | `false` | 额外生成 PBR 贴图（metallic/roughness/normal）；`ai_model` 为 meshy-6/latest 时另含 emission 贴图（`texture_resolution: 8k` 时无 emission） |
| `texture_resolution` | string | 否 | `2k` | `2k`(2048²)/`4k`(4096²)/`8k`(8192²)；4k/8k 要求 meshy-6/latest，8k 无 emission |
| `hd_texture` | bool | 否 | `false` | ⚠ 已废弃，等价 `texture_resolution: "4k"` |
| `texture_prompt` | string | 否 | — | 附加贴图引导文本，最长 600 字符 |
| `texture_image_url` | string | 否 | — | 2D 引导图：**公开 URL 或 base64 Data URI**（`data:image/jpeg;base64,...`），支持 jpg/jpeg/png |
| `ai_model` | string | 否 | `latest` | 与 preview 的模型不兼容会报错（见 400 失败模式） |
| `moderation` | bool | 否 | `false` | 审查 texture_prompt 文本与 texture_image_url 图片 |
| `remove_lighting` | bool | 否 | `true` | 去掉基础色贴图上的高光阴影；仅 meshy-6/latest |
| `target_formats` / `alpha_thumbnail` / `auto_size` | — | 否 | — | 同 §2.1 |

> `texture_image_url` 与 `texture_prompt` 同时给出时，**texture_prompt 优先**。

curl：

```bash
curl https://api.meshy.ai/openapi/v2/text-to-3d \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "mode": "refine",
    "preview_task_id": "018b314a-...",
    "enable_pbr": true,
    "texture_resolution": "4k",
    "target_formats": ["glb", "fbx"]
  }'
```

### 2.3 查询任务（轮询）

`GET /openapi/v2/text-to-3d/:id`（preview 与 refine 通用），响应为 **Text to 3D Task 对象**（字段见 §2.4）。

curl：

```bash
curl https://api.meshy.ai/openapi/v2/text-to-3d/018b314a-... \
  -H "Authorization: Bearer ${MESHY_API_KEY}"
```

轮询建议：`status` 为 `SUCCEEDED` / `FAILED` / `CANCELED` 即终态；`FAILED` 时看 `task_error`。

### 2.4 Text to 3D Task 对象字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 任务唯一 id（格式是 k-sortable UUID，官方声明勿做格式假设） |
| `type` | string | `text-to-3d-preview`（preview）或 `text-to-3d-refine`（refine） |
| `model_urls` | object | 模型下载 URL 集合；未生成的格式**字段被省略**而非空串 |
| `model_urls.glb` / `.fbx` / `.usdz` / `.obj` / `.mtl` / `.stl` / `.3mf` | string | 各格式下载 URL（`3mf` 仅在显式请求时存在） |
| `prompt` | string | 原始 prompt |
| `negative_prompt` / `art_style` / `texture_richness` | string | ⚠ 已废弃，保留兼容，无功能影响 |
| `texture_prompt` | string | refine 阶段使用的引导文本 |
| `texture_image_url` | string | 使用的引导图 URL |
| `thumbnail_url` | string | 模型缩略图下载 URL |
| `alpha_thumbnail_url` | string | RGBA 透明缩略图（仅 `alpha_thumbnail: true` 且渲染成功时存在） |
| `video_url` | string | ⚠ 已废弃（预览视频，未来移除） |
| `progress` | int | 0–100；成功为 100 |
| `started_at` / `created_at` / `finished_at` | timestamp | 毫秒 epoch；未开始/未完成时为 0 |
| `status` | string | `PENDING` / `IN_PROGRESS` / `SUCCEEDED` / `FAILED` / `CANCELED` |
| `texture_urls` | array | 贴图 URL 对象数组（通常 1 个）：`base_color`、`metallic`、`normal`、`roughness`（`enable_pbr: false` 时省略）、`emission`（`enable_pbr: false` 或 meshy-5 时省略） |
| `preceding_tasks` | int | 排队中前面的任务数（仅 PENDING 时有意义） |
| `task_error` | object | 失败详情，见 §8 |
| `consumed_credits` | int | 消耗积分（FAILED 为 0，退费） |

> 官方文档未记载 Text to 3D 任务对象含 `expires_at`（Image to 3D / Rigging / Animation 任务对象有）。preview 未出贴图时 `model_urls` 具体含哪些格式，官方文档未逐项记载。

其他端点：`DELETE /openapi/v2/text-to-3d/:id`（永久删除任务与全部关联数据）；`GET /openapi/v2/text-to-3d`（分页列表）；`GET /openapi/v2/text-to-3d/:id/stream`（SSE 实时进度，PENDING/IN_PROGRESS 时只推必要字段）。

### 2.5 失败模式（HTTP 状态码）

- `400 Bad Request`：缺参（prompt/mode）、参数非法（如 art_style 不在允许值）、prompt 超长；refine 场景：preview_task_id 无效、preview 未成功、preview/refine 模型不兼容。
- `401 Unauthorized`：API key 无效。
- `402 Payment Required`：积分不足。
- `404 Not Found`：preview_task_id 不存在。
- `429 Too Many Requests`：超速率限制。

---

## 3. Image to 3D / Multi-Image to 3D（v1）

图片输入支持两种形式（官方文档明确）：**公开可访问的 URL**，或 **base64 Data URI**（`data:image/jpeg;base64,<data>`）。仅支持 jpg/jpeg/png。

### 3.1 Image to 3D

`POST /openapi/v1/image-to-3d`。`input_task_id` 与 `image_url` **二选一**（都传时 `input_task_id` 优先）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `input_task_id` | string | 已完成的图片生成任务 id（Text to Image / Image to Image），须经 API 运行、SUCCEEDED、且恰好产出 1 张图 |
| `image_url` | string | 图片公开 URL 或 base64 Data URI |
| `model_type` | string | `standard`（默认）；`smart-topology`（用 `meshy-t1`/`meshy-t2`，此模式下 `topology`/`should_remesh`/`save_pre_remeshed_model` 被忽略）；`lowpoly`（已废弃，建议 smart-topology） |
| `ai_model` | string | standard 模式：`meshy-5`/`meshy-6`/`meshy-7`/`latest`(Meshy 7)；smart-topology 模式：`meshy-t2`（默认，可设 `target_polycount` 控面数）/`meshy-t1`（旧低模，不支持面数设置） |
| `ultra_mode` | bool | 更高保真几何细节；仅 meshy-7/latest |
| `should_texture` | bool | 默认 `true`；false 跳过贴图阶段 |
| `should_remesh` | bool | 默认 `false`(meshy-6/7)、`true`(其他) |
| `target_polycount` | int | 目标面数。两种情况生效：① `should_remesh: true` 的 standard 模型，100–300,000，默认 30,000（`decimation_mode` 设置时优先，本参数被忽略）；② `model_type: smart-topology` + `meshy-t2` 直接按此面数生成，100–15,000，默认 4,000 |
| `symmetry_mode` / `is_a_t_pose` | — | ⚠ 已废弃（同 §2.1） |
| `pose_mode` | string | `a-pose` / `t-pose` / `""` |
| `image_enhancement` | bool | 默认 `true`，优化输入图；false 保留原图观感；仅 meshy-6/7/latest |
| `remove_lighting` | bool | 默认 `true`；仅 meshy-6 |
| `moderation` | bool | 审查 image_url、texture_image_url、texture_prompt |
| `target_formats` / `auto_size` / `alpha_thumbnail` | — | 同 §2.1 |
| `multi_view_thumbnails` | bool | 额外渲染前/右/后/左四视角 512×512 PNG 缩略图 → `thumbnail_urls`；约 +3s 延迟 |

curl：

```bash
curl https://api.meshy.ai/openapi/v1/image-to-3d \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_url": "https://example.com/character.png",
    "ai_model": "meshy-6",
    "should_texture": true,
    "target_formats": ["glb"]
  }'
```

### 3.2 Multi-Image to 3D

`POST /openapi/v1/multi-image-to-3d`。`input_task_id` 与 `image_urls` 二选一。

| 参数 | 类型 | 说明 |
|---|---|---|
| `input_task_id` | string | 已完成的图片生成任务 id（Text to Image / Image to Image / Text to Image Multi-View / Image to Image Multi-View），须经 API 运行、SUCCEEDED，产出 1–4 张图 |
| `image_urls` | string[] | **1–4 张**同物体不同角度的图（URL 或 base64 Data URI）。meshy-7/latest 时第 1 张为主视（正面），其余顺序无关 |
| `ai_model` | string | `meshy-5`/`meshy-6`/`meshy-7`/`latest`(Meshy 7) |
| `should_texture` / `should_remesh` | bool | 同 §3.1 |
| `symmetry_mode` / `is_a_t_pose` / `pose_mode` | — | 同 §2.1（前两者废弃） |
| `image_enhancement` | bool | 默认 true；仅 meshy-6/7/latest |
| `remove_lighting` | bool | 默认 true；仅 meshy-6/7/latest |
| `moderation` | bool | 审查 image_urls 每张图与 texture_prompt |
| `target_formats` / `auto_size` / `alpha_thumbnail` / `multi_view_thumbnails` | — | 同前 |

curl：

```bash
curl https://api.meshy.ai/openapi/v1/multi-image-to-3d \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "image_urls": [
      "https://example.com/front.png",
      "https://example.com/side.png",
      "https://example.com/back.png"
    ],
    "ai_model": "meshy-7",
    "target_formats": ["glb", "fbx"]
  }'
```

### 3.3 查询与任务对象

`GET /openapi/v1/image-to-3d/:id`、`GET /openapi/v1/multi-image-to-3d/:id` 轮询；另有 List / DELETE / SSE /stream 端点（路径模式一致）。

Task 对象与 §2.4 基本一致，差异点：

- `type`：`image-to-3d` / `multi-image-to-3d`。
- `model_urls` 增加 `pre_remeshed_glb`（仅 `should_remesh: true` 且 `save_pre_remeshed_model: true` 时存在，为 remesh 前的原始 GLB）。
- `thumbnail_urls`：四视角缩略图对象 `{front, right, back, left}`（仅 `multi_view_thumbnails: true` 且成功时存在；`thumbnail_url` 等价 `thumbnail_urls.front`，兼容保留）。
- `texture_urls`：emission 在 meshy-5/7/latest 时省略（与 Text to 3D 的 meshy-5 规则略有差异，见官方页面）。
- Image to 3D 任务对象含 `expires_at`；`ultra_mode` 字段仅在 meshy-7/latest 且显式设置时回显。

失败模式：400（缺 image_url/image_urls、input_task_id 无效、图片数量不在 1–4、格式不支持、URL 不可达 404/超时、base64 损坏、`enable_pbr` 与 `should_texture: false` 组合非法）、401、402、429。

---

## 4. Auto Rigging（自动绑骨）

官方文档名 "Rigging API"（[Rigging](https://docs.meshy.ai/en/api/rigging)）。仅适用于**标准人形（双足）带贴图资产**；无贴图网格、非人形、四肢结构不清的人形均不适用。

### 4.1 创建任务

`POST /openapi/v1/rigging`。`input_task_id` 与 `model_url` 二选一（都传时 `input_task_id` 优先）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `input_task_id` | string | 二选一 | — | 要绑骨的任务 id（官方：支持带贴图的人形模型）；**该路径下超过 300,000 面的模型不支持**，需先用 Remesh API 降面 |
| `model_url` | string | 二选一 | — | **仅支持 .glb**，公开 URL 或 Data URI；**角色面部须朝 +Z 轴**（glTF 标准前向），朝其他轴会导致姿态估计失败 |
| `height_meters` | number | 否 | `1.7` | 角色近似身高（米），正数，帮助缩放与绑骨精度 |
| `texture_image_url` | string | 否 | — | UV 展开的 base color 贴图（仅 .png，URL 或 Data URI） |

> 官方文档参数表**未记载** `rig_type` 之类的绑骨类型参数；也未记载 `enable_animation` / `animation_action_id` 等“绑骨同时套动作”的参数（这两个参数在第三方网关 fal 的包装文档中出现，官方 API 文档页面没有 —— 官方文档未记载，实现时勿依赖）。
> 输出里的 `basic_animations`（自带 walk/run）字段在官方任务对象中有记载，但其触发开关（参数表里出现了 "if generate_basic_animations was implicitly true or enabled by default" 的描述）**未作为显式参数列出** —— 官方文档未记载如何显式开启。

curl：

```bash
curl https://api.meshy.ai/openapi/v1/rigging \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "input_task_id": "018b314a-...（已成功的 Text/Image to 3D 任务）",
    "height_meters": 1.7
  }'
```

或传外部 GLB：

```bash
curl https://api.meshy.ai/openapi/v1/rigging \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model_url": "https://example.com/character.glb",
    "height_meters": 1.6
  }'
```

### 4.2 查询与任务对象

`GET /openapi/v1/rigging/:id` 轮询（另有 List / DELETE / SSE /stream）。

Rigging Task 对象（注意输出包在 `result` 里）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `type` | string | `type` 恒为 `rig` |
| `status` / `progress` | — | 同通用 |
| `created_at` / `started_at` / `finished_at` / `expires_at` | timestamp | 毫秒 epoch；**`expires_at` 为结果资产过期时间** |
| `task_error` | object | 失败详情（§8） |
| `consumed_credits` | int | 同通用 |
| `result` | object | 成功时才有，失败为 null |
| `result.rigged_character_fbx_url` | string | 绑骨后角色 FBX |
| `result.rigged_character_glb_url` | string | 绑骨后角色 GLB |
| `result.basic_animations` | object(可选) | 默认自带的基础动画（walk/run）URL 集合 |
| `result.basic_animations.walking_glb_url` / `walking_fbx_url` | string | 走路动画（含蒙皮 skin） |
| `result.basic_animations.walking_armature_glb_url` | string | 走路动画骨骼（armature）GLB |
| `result.basic_animations.running_glb_url` / `running_fbx_url` | string | 跑步动画（含蒙皮） |
| `result.basic_animations.running_armature_glb_url` | string | 跑步动画骨骼 GLB |
| `preceding_tasks` | int | 排队数（仅 PENDING 有意义） |

失败模式：400（缺参数、非 .glb 扩展名、URL 不可达、任务无效、面数超限）、401、402、**422 Unprocessable Entity（姿态估计失败：可能不是有效人形）**、429。

---

## 5. Animation（套动作）

`POST /openapi/v1/animations`（[Animation](https://docs.meshy.ai/en/api/animation)）。输入是**已成功的 rigging 任务 id**。

### 5.1 创建任务

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `rig_task_id` | string | 是 | — | 成功完成的 rigging 任务 id（来自 `POST /openapi/v1/rigging`），其角色将被动画化 |
| `action_id` | integer | 是 | — | 动作库 id（见 §5.4 动作目录） |
| `post_process` | object | 否 | — | 可选后处理，省略则输出标准动画文件 |
| `post_process.operation_type` | string | 条件必填 | — | `change_fps` / `fbx2usdz` / `extract_armature` |
| `post_process.fps` | int | 条件必填 | `30` | 仅 `change_fps` 时有效；允许 `24/25/30/60` |

curl：

```bash
curl https://api.meshy.ai/openapi/v1/animations \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "rig_task_id": "018b314a-...（rigging 任务 id）",
    "action_id": 92
  }'
# => {"result": "018c425b-..."}
```

带后处理（改 FPS）：

```bash
curl https://api.meshy.ai/openapi/v1/animations \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "rig_task_id": "018b314a-...",
    "action_id": 92,
    "post_process": {
      "operation_type": "change_fps",
      "fps": 24
    }
  }'
```

### 5.2 查询与任务对象

`GET /openapi/v1/animations/:id` 轮询（另有 List / DELETE / SSE /stream）。

Animation Task 对象（输出在 `result` 里）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `type` / `status` / `progress` | — | `type` 恒为 `animate` |
| `created_at` / `started_at` / `finished_at` / `expires_at` | timestamp | 毫秒 epoch |
| `task_error` / `consumed_credits` / `preceding_tasks` | — | 同通用 |
| `result.animation_glb_url` | string | 动画 GLB（带蒙皮） |
| `result.animation_fbx_url` | string | 动画 FBX（带蒙皮） |
| `result.processed_usdz_url` | string | USDZ（后处理产物） |
| `result.processed_armature_fbx_url` | string | 骨骼 FBX（后处理产物） |
| `result.processed_animation_fps_fbx_url` | string | 改 FPS 后的 FBX（如 change_fps） |

curl：

```bash
curl https://api.meshy.ai/openapi/v1/animations/018c425b-... \
  -H "Authorization: Bearer ${MESHY_API_KEY}"
```

失败模式：400（缺 rig_task_id/action_id、rig 任务无效、action_id 无效）、401、402、404（rig_task_id 不存在）、429。

### 5.3 动作目录

官方**没有动作目录 API 端点**（官方文档未记载 catalog/actions 枚举端点），唯一权威来源是静态参考页 [Animation Library Reference](https://docs.meshy.ai/en/api/animation-library)：**action_id 取值 0–696**，每行格式 `id 动作名 分类 子分类`，例如：

```
0  Idle  DailyActions  Idle
1  Walking_Woman  WalkAndRun  Walking
2  Alert  DailyActions  LookingAround
...
92  Double_Combo_Attack  Fighting  AttackingwithWeapon
...
509  Lean_Forward_Sprint  WalkAndRun  Running
...
696  Walk_with_Walker_Support_inplace  WalkAndRun  Walking
```

- 目录共分大类：`Dancing`、`Fighting`（AttackingwithWeapon/Punching/Blocking/CastingSpell/GettingHit/Dying/Transitioning）、`DailyActions`（Idle/Interacting/Pushing/Sleeping/PickingUpItem/WorkingOut/LookingAround/Drinking/Transitioning）、`BodyMovements`（Acting/Climbing/VaultingOverObstacle/PerformingStunt/Jumping/HangingfromLedge/FallingFreely）、`WalkAndRun`（Walking/Running/CrouchWalking/Swimming/TurningAround）等。
- id 存在空洞（如 332、373–374、380、383、400、418、423–424、454、469、600、603、614、633–634、653、655 等缺失），**不要假设 0–696 连续**。
- 后缀 `_inplace`（如 `601 Backflip_inplace`、`692 walking_2_inplace`）为原地（不位移）版本。
- 动作目录为官方静态页面；DSH 插件需随包固化一份静态目录（本包已固化 ~680 条 meshy-actions.ts 目录；官方现目录约 690 条）。

### 5.4 关于 "绑骨即带动作"

官方 Rigging 文档输出对象含 `basic_animations`（walk/run），说明默认绑骨会带基础动画；但显式开关参数官方文档未记载（见 §4.1 注）。Animation 端点则始终需要先有 rig_task_id 再按 action_id 套动作。

---

## 6. 余额 / 配额 / 速率限制

### 6.1 余额查询

`GET /openapi/v1/balance`（[Balance](https://docs.meshy.ai/en/api/balance)），返回 `{"balance": <int>}`，即当前剩余积分。

```bash
curl https://api.meshy.ai/openapi/v1/balance \
  -H "Authorization: Bearer ${MESHY_API_KEY}"
# => {"balance": 1000}
```

> 官方**没有**“积分消耗明细/历史”端点（官方文档未记载）。单任务消耗可从任务对象的 `consumed_credits` 得知。

### 6.2 速率限制（[Rate Limits](https://docs.meshy.ai/en/api/rate-limits)）

两类限制，**按账号维度**统计（所有 API key 共享）：

1. **Requests per Second（每秒请求数）**：网络请求频率。
2. **Queue Tasks（队列并发任务数）**：同时排队中的生成任务数。**计入**：Text to 3D、Image to 3D、Text to Texture、Remesh；**不计入**：Upload、Balance 等。

各 tier 限额：

| User Tier | Requests per Second | Queue Tasks | Priority |
|---|---|---|---|
| Pro | 20 | 10 | Default |
| Premium | 20 | 30 | 高于 Pro |
| Ultra | 20 | 100 | Highest |
| Studio | 20 | 20 | 高于 Pro |
| Enterprise | 100 | 默认 50，可定制 | Highest |

超限返回 `429 Too Many Requests`，两种命中类型响应不同：
- **请求频率超限**：429 + `RateLimitExceeded` 消息。
- **并发队列超限**：429 + `NoMoreConcurrentTasks` 消息。

任务处理速度还受优先级影响。实现上：创建任务失败 429 时按上述两种消息区分退避策略（队列满应等待而非立刻重试）。

---

## 7. 错误码格式（[Errors](https://docs.meshy.ai/en/api/errors)）

两类错误：

### 7.1 请求级错误（HTTP 状态码即时返回）

响应体为单一 `message` 字段：`{"message": "<描述>"}`。

| 状态码 | 含义 |
|---|---|
| 200 OK | 成功 |
| 202 Accepted | 任务已接受（创建任务的正常返回） |
| 400 Bad Request | 缺参/参数非法 |
| 401 Unauthorized | 无有效 API key |
| 402 Payment Required | 账号余额不足 |
| 403 Forbidden | 被禁止；典型场景：**浏览器端 JS 直接调 API 被 CORS 拦截**（必须服务端代理） |
| 404 Not Found | 资源不存在（如无效 task id） |
| 429 Too Many Requests | 超速率限制（见 §6.2） |
| 5xx | 服务端错误（看官方状态页/Discord） |

### 7.2 任务级错误（`task_error` 对象，轮询时在任务响应中）

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | string | 错误类别，失败任务必有 |
| `message` | string | 人类可读描述，必有 |
| `code` | string | 具体错误码，可选（有更多细节时出现） |
| `doc_url` | string | 该错误码的文档链接，可选（code 存在时出现） |

`type` 取值与重试策略：

| type | 含义 | 处理 |
|---|---|---|
| `invalid_input` | 输入有问题 | 看 code/message，修正后重试 |
| `timeout` | 处理超时 | 多为瞬时，重试；持续失败则简化输入 |
| `service_unavailable` | 服务暂不可用 | 稍等重试 |
| `server_error` | 内部错误 | 重试；持续则带 task id 联系支持 |

`code` 参考（与 3D 生成相关的主要条目）：

| code | 说明 |
|---|---|
| `image_too_complex` | 输入图/提示描述的物体几何过于复杂（一图多物、密集重复结构、复杂建筑等）→ 单一主体、简化 |
| `model_missing_uv` | 模型无 UV 坐标（常见于 STL）→ 用 GLB/FBX/OBJ |
| `model_insufficient_uv` | UV 覆盖过小 → 重新展开 UV 或省略 enable_original_uv |
| `invalid_input` | 兜底校验失败（空文件、meshopt 压缩 GLB、ASCII FBX、无 3D 对象、安全过滤） |
| `moderation_blocked` | 内容安全过滤拒绝 → 改写 prompt/换参考图 |
| `timeout` | 处理超时 |
| `format_conversion_failed` | 生成成功但格式转换失败 → 重试或换格式 |

官方最佳实践：`timeout`/`service_unavailable` 用指数退避重试；记录 task id 便于排查；提交前校验输入。

---

## 8. 对 DSH 迁移的关键结论

1. **认证**：Bearer key 由用户在官网 API settings 页自建（meshy.ai 账号），天然适配 DSH 的 credentials 机制（环境变量 / `$DSH_HOME/.credentials.yaml`），插件不内置 key；未配置时回退 mock 与余额预检（`GET /openapi/v1/balance` 免费、不计队列）。
2. **任务异步模型**：所有能力都是 create → poll → download 三步。DSH 的 `ctx.jobs` 长任务模式正好对应；SSE `/stream` 可选但非必需（轮询即可）。
3. **计费预检**：创建前可用 `GET /openapi/v1/balance` 检查余额；`402` 表示余额不足；`429` 需区分 `RateLimitExceeded`（限频退避）与 `NoMoreConcurrentTasks`（队列满，等待而非重试）。
4. **两阶段文生 3D**：`mode: preview`（几何）→ `mode: refine`（贴图）；`texture_image_url` 支持 base64 Data URI，可避免外网 URL 依赖。
5. **绑骨/动作**：rigging 输出自带 walk/run（`basic_animations`）；Animation 按 `rig_task_id + action_id` 执行；动作目录仅静态参考页（0–696，有空洞），需随包固化静态目录（官方页面约 690 条）。
6. **下载**：资产 URL 带签名且有过期时间（`expires_at`），必须立即下载；文件格式用 `target_formats` 显式限定以减少任务耗时。
7. **官方文档未记载、勿依赖**：API key 字符串格式；Text to 3D 任务对象的 `expires_at`；rigging 的显式参数（如 `generate_basic_animations` / `enable_animation` / `animation_action_id`、`rig_type`）；动作目录 API 端点；积分消费明细端点。低模重拓扑官方路径为 Image to 3D 的 `smart-topology`（`meshy-t2` + `target_polycount`）或 `model_type: lowpoly`（废弃），另有独立 Remesh API（本文档分工未展开，见对应分工文档）。
