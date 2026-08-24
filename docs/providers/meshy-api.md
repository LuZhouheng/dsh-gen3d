# Meshy 官方 API 协议文档（DSH 迁移参考）

> 本文档全部内容基于 Meshy 官方文档（docs.meshy.ai）实际抓取整理，不含任何第三方网关包装的字段。
> 抓取日期：2026-08-24。官方文档为英文，本文为中文转述 + 字段直译。
> 本次抓取另核对官方合并全文 <https://docs.meshy.ai/llms-full.txt> 与官方免鉴权动作目录 JSON（§5.3）；
> 与 2026-08-13 快照的差异（meshy-7 / ultra_mode / smart-topology 等）已在文内标注。
> Changelog 2026-08-24 最新条目（gpt-image-2 的 aspect_ratio 扩展）已核对——仅涉及
> Text to Image / Image to Image API，本插件未实现图像生成/编辑，仅 §7 端点地图注记。
>
> 来源 URL（均为官方）：
> - API 总览：https://docs.meshy.ai/en/api/
> - 快速开始：https://docs.meshy.ai/zh/api/quick-start（入门四步：建 key → 建任务 → 轮询 → 下载；
>   页面提及的官方 Meshy MCP server 属「AI 集成」便利通道——本插件为 DSH 原生 cordis/CLI 路线，**不使用 MCP**）
> - 认证：https://docs.meshy.ai/en/api/authentication
> - Text to 3D：https://docs.meshy.ai/en/api/text-to-3d
> - Image to 3D：https://docs.meshy.ai/en/api/image-to-3d
> - Multi-Image to 3D：https://docs.meshy.ai/en/api/multi-image-to-3d
> - Remesh：https://docs.meshy.ai/en/api/remesh
> - Rigging：https://docs.meshy.ai/en/api/rigging
> - Animation：https://docs.meshy.ai/en/api/animation
> - Animation Library（动作目录）：https://docs.meshy.ai/en/api/animation-library
> - Asset Retention（资产保留）：https://docs.meshy.ai/en/api/asset-retention
> - Pricing（定价）：https://docs.meshy.ai/zh/api/pricing
> - Changelog：https://docs.meshy.ai/en/api/changelog
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
- 资产下载 URL 是带签名的临时 URL，有 `expires_at` 有效期。官方 API 文档现设专页 [Asset Retention](https://docs.meshy.ai/en/api/asset-retention)：非 Enterprise 账号生成的资产最多保留 **3 天**（动画文档示例约 3 天即该口径），Enterprise 无限保留；API 文档本身以 `expires_at` 字段为准。**拿到 URL 后应立即下载**，过期后无刷新途径（窗口期内重查任务返回同一 URL）。
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

> 官方文档明确 API key 格式为 `msy_<随机串>`（认证页示例 `msy_YOUR_API_KEY`；llms-full.txt 亦注明 “have the format `msy_<random-string>`”）。注意是下划线 `msy_` 前缀，非连字符。

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
| `model_type` | string | 否 | `standard` | `standard` 高细节；`smart-topology` 智能拓扑（用 `ai_model`: `meshy-t2`，5 积分，见下；选它时 `should_remesh`/`decimation_mode` 被忽略、仅接受 `topology: triangle`）；`lowpoly` ⚠ **已废弃**（仍兼容服务流量，建议 smart-topology；选 lowpoly 时 `ai_model`/`topology`/`target_polycount`/`should_remesh` 被忽略） |
| `ai_model` | string | 否 | `latest` | standard 模式：`meshy-5` / `meshy-6` / `meshy-7` / `latest`(Meshy 7)；smart-topology 模式：`meshy-t2`（默认） |
| `ultra_mode` | bool | 否 | `false` | Ultra 档生成，表面细节更精细；耗时更长，**+5 积分**；仅 `ai_model` 为 meshy-7/latest，且仅 preview 阶段 |
| `should_remesh` | bool | 否 | `false`(meshy-6/7) / `true`(其他) | 是否启用 remesh 阶段；最高质量建议 false |
| `target_polycount` | int | 否 | — | 目标面数（实际可能偏差）。两种独立情形：① `should_remesh: true` 的 standard 模型，100–300,000，默认 30,000（`decimation_mode` 设置时优先，本参数被忽略）；② `model_type: smart-topology` + `meshy-t2` 直接按此面数生成，100–15,000，默认 4,000 |
| `decimation_mode` | int | 否 | — | 自适应减面档：1 ultra / 2 high / 3 medium / 4 low；设置时 `target_polycount` 被忽略（两者互斥，本参数优先）；smart-topology 模式下被忽略 |
| `topology` | string | 否 | — | `quad`（四边面为主）/ `triangle`；smart-topology 仅接受 `triangle` |
| `symmetry_mode` | string | 否 | `auto` | ⚠ 已废弃，不再影响输出（off/auto/on） |
| `pose_mode` | string | 否 | `""` | `a-pose` / `t-pose` / `""` 不指定 |
| `is_a_t_pose` | bool | 否 | `false` | ⚠ 已废弃，改用 `pose_mode` |
| `art_style` | string | 否 | `realistic` | ⚠ 已废弃，Meshy-6 不支持（realistic/sculpture） |
| `moderation` | bool | 否 | `false` | 内容安全审查（审查 prompt 文本） |
| `target_formats` | string[] | 否 | 全部 | 输出格式：`glb,obj,fbx,stl,usdz,3mf`；省略时除 `3mf` 外全出；`3mf` 必须显式指定才生成 |
| `alpha_thumbnail` | bool | 否 | `false` | 额外渲染透明背景 (RGBA) 缩略图 → `alpha_thumbnail_url` |
| `auto_size` | bool | 否 | `false` | AI 视觉自动估算真实高度并缩放；原点默认在底部 |
| `origin_at` | string | 否 | `bottom` | 原点位置：`bottom` / `center`；与 `auto_size` 配合（auto_size 启用时原点默认底部，除非显式指定 origin_at） |

> **插件净化行为（dsh-gen3d 实现约定，2026-08-24 对齐）**：`providerParams` 传
> `model_type: smart-topology` 时，插件强制 `ai_model: meshy-t2`，并剥离
> `should_remesh` / `decimation_mode` / `ultra_mode`（官方本就忽略，见上表注），
> `topology` 仅接受 `triangle`，`target_polycount` 钳制在 100–15,000（默认 4,000）；
> standard 路径 `target_polycount` 钳制在 100–300,000。

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
| `enable_pbr` | bool | 否 | `false` | 额外生成 PBR 贴图（metallic/roughness/normal）；emission 贴图规则：`ai_model` 为 meshy-6 时产出（`texture_resolution: 8k` 时无 emission），**meshy-7/latest 不产出 emission** |
| `texture_resolution` | string | 否 | `2k` | `2k`(2048²)/`4k`(4096²)/`8k`(8192²)；4k/8k 要求 meshy-6/7/latest，8k 无 emission |
| `hd_texture` | bool | 否 | `false` | ⚠ 已废弃，等价 `texture_resolution: "4k"` |
| `texture_prompt` | string | 否 | — | 附加贴图引导文本，最长 600 字符 |
| `texture_image_url` | string | 否 | — | 2D 引导图：**公开 URL 或 base64 Data URI**（`data:image/jpeg;base64,...`），支持 jpg/jpeg/png |
| `ai_model` | string | 否 | `latest` | `meshy-5` / `meshy-6` / `meshy-7` / `latest`(Meshy 7)；`latest` 与 preview 解析一致（当前均为 Meshy 7），latest preview + latest refine 必落同一贴图模型；与 preview 的模型不兼容会报错（见 400 失败模式） |
| `moderation` | bool | 否 | `false` | 审查 texture_prompt 文本与 texture_image_url 图片 |
| `remove_lighting` | bool | 否 | `true` | 去掉基础色贴图上的高光阴影；**仅 meshy-6 生效**，meshy-7/latest 接受但忽略 |
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
| `ultra_mode` | bool | 回显 preview 创建时显式设置的 ultra_mode 值；仅 meshy-7/latest 且显式设置时存在，否则省略 |
| `thumbnail_url` | string | 模型缩略图下载 URL |
| `alpha_thumbnail_url` | string | RGBA 透明缩略图（仅 `alpha_thumbnail: true` 且渲染成功时存在） |
| `video_url` | string | ⚠ 已废弃（预览视频，未来移除） |
| `progress` | int | 0–100；成功为 100 |
| `started_at` / `created_at` / `finished_at` | timestamp | 毫秒 epoch；未开始/未完成时为 0 |
| `status` | string | `PENDING` / `IN_PROGRESS` / `SUCCEEDED` / `FAILED` / `CANCELED` |
| `texture_urls` | array | 贴图 URL 对象数组（通常 1 个）：`base_color`、`metallic`、`normal`、`roughness`（`enable_pbr: false` 时省略）、`emission`（`enable_pbr: false` 或 meshy-5 时省略；按 §2.2 `enable_pbr` 参数说明，meshy-7/latest 不产出 emission、8k 亦无——官方任务对象字段文案仅提 meshy-5，两处表述不一致，以 changelog 与参数说明为准） |
| `preceding_tasks` | int | 排队中前面的任务数（仅 PENDING 时有意义） |
| `task_error` | object | 失败详情，见 §9 |
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
| `should_texture` | bool | 默认 `true`；false 跳过贴图阶段（mesh-only） |
| `should_remesh` | bool | ⚠ **官方页面间默认值自相矛盾**：multi-image 页写 `false(meshy-6) / true(其他)`，text-to-3d 与 image-to-3d 页写 `false(meshy-6/7) / true(其他)`——实现**建议显式传值**，勿依赖默认 |
| `symmetry_mode` / `is_a_t_pose` / `pose_mode` | — | 同 §2.1（前两者废弃） |
| `texture_prompt` / `texture_image_url` | — | 贴图引导（文本 / 2D 图，规则同 §2.2；**与 `texture_image_urls` 互斥**，两者并存时 texture_prompt 优先） |
| `texture_image_urls` | string[] | **1–4 张**同物体不同角度的贴图引导图（URL 或 base64 Data URI，jpg/jpeg/png），第 1 张为主视（正面）；**仅 `ai_model` meshy-7/latest**；与 `image_urls` 相互独立（两张列表可不同图、不同数量）；**不能与 `texture_image_url`/`texture_prompt` 组合**（官方失败模式另注：需 `should_texture: true`） |
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
- `texture_urls`：emission 在 `enable_pbr: false` 或 `ai_model: meshy-5` 时省略（任务对象字段文案）；按本页 `enable_pbr` 参数说明（与 Text to 3D 同款规则）emission 仅 meshy-6 产出，meshy-7/latest 不产出；`texture_resolution: 8k` 时任何模型均无 emission。
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
| `task_error` | object | 失败详情（§9） |
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
| `action_id` | integer | 是 | — | 动作库 id（见 §5.3 动作目录） |
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

官方 [Animation Library](https://docs.meshy.ai/en/api/animation-library) 页现给出**完整目录 JSON**——页面原文：“The full list of available animations (with `action_id`, name, category, preview URL) is served as JSON at <https://api.meshy.ai/web/public/animations/resources> — fetch it directly to retrieve the current catalog.” 该端点为**免鉴权 GET**（`/web/public/` 前缀即网页端公共资源路径）；此前“官方没有动作目录 API 端点”的表述按此更新（官方有的是“动作库只读数据源”，并非创建/管理动作的认证 API）。

实测（2026-08-24 抓取）：`result.total = 680`（即当前权威条数）；`id` 范围 **-2 ~ 696**——**-2**=`Walking`、**-1**=`Running` 为默认动作（`isDefault: true`，即绑骨自带基础动画所采用的两条），静态参考页的行列只列 0–696、未含 -2/-1；**90 条** `_inplace` 原地版本（JSON 中 90 条带 `tag` 标记，key 均以 `_inplace` 结尾）；`isFree` 实测 **22 条 `true`**（免费，含 -2/-1 两条默认动作）、**658 条 `false`**（收费标记，Animation 任务本身 3 积分，见官方 Pricing 表）；每条新增 **`rigType`** 维度：`biped`(2) / `style_01`(2) / `style_02`(671) / `style_03`(5)——静态参考页无此列。

静态参考页行列格式仍为 `id 动作名 分类 子分类`，例如：

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
- id 存在空洞（如 332、373–374、380、383、400、418、423–424、454、469、600、603、614、633–634、653、655 等缺失），**不要假设 id 连续**（含 -2/-1 与 0–696 全范围）。
- 后缀 `_inplace`（如 `601 Backflip_inplace`、`692 walking_2_inplace`）为原地（不位移）版本。
- 目录条数以该 JSON 的 `total` 字段为准（实测 680）；DSH 插件需随包固化一份静态目录（本包已固化 ~680 条 meshy-actions.ts 目录，与官方 JSON 一致）。

### 5.4 关于 "绑骨即带动作"

官方 Rigging 文档输出对象含 `basic_animations`（walk/run），说明默认绑骨会带基础动画；但显式开关参数官方文档未记载（见 §4.1 注）。Animation 端点则始终需要先有 rig_task_id 再按 action_id 套动作。

---

## 6. Remesh（重建网格 / 降面 / 重拓扑）

`POST /openapi/v1/remesh`（[Remesh](https://docs.meshy.ai/en/api/remesh)）。对已有 3D 模型
重建网格并导出多格式；2026-05-22 起 convert / resize 功能已拆分为独立 Convert / Resize API
（见 §7.1），Remesh 上的旧参数仍兼容（建议新集成使用新端点）。5 积分 / 次。

### 6.1 创建任务

`POST /openapi/v1/remesh`。`input_task_id` 与 `model_url` **二选一**（都传时 `input_task_id` 优先）。

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `input_task_id` | string | 二选一 | — | 已完成的重建网格输入任务 id：text-to-3d-preview / text-to-3d-refine / image-to-3d / retexture，状态须 SUCCEEDED |
| `model_url` | string | 二选一 | — | 3D 模型：公开 URL 或 Data URI。支持 `.glb` / `.gltf` / `.obj` / `.fbx` / `.stl`；Data URI 的 MIME 为 `application/octet-stream` |
| `target_formats` | string[] | 否 | `["glb"]` | 未指定仅生成 GLB；可选 `glb / fbx / obj / usdz / blend / stl / 3mf`（`3mf` 仅显式请求时产出） |
| `topology` | string | 否 | `triangle` | `quad`（以四边形为主的网格）/ `triangle`（简化三角网格） |
| `target_polycount` | int | 否 | `30,000` | 目标面数，100–300,000（实际可能按几何复杂度偏差）；`decimation_mode` 设置时本参数被忽略 |
| `decimation_mode` | int | 否 | — | 自适应减面档：1 超高面数 / 2 高 / 3 中 / 4 低；设置后 `target_polycount` 被忽略（两者互斥，本参数优先） |
| `resize_height` | number | 否 | `0` | ⚠ 已废弃（2026-05-22 起拆分为独立 Resize API，仍兼容）：缩放到指定高度（米）；与 `auto_size` / `resize_longest_side` 互斥 |
| `resize_longest_side` | number | 否 | `0` | ⚠ 已废弃（同前）：最长边缩放至指定值（米）；互斥同前 |
| `auto_size` | bool | 否 | `false` | ⚠ 已废弃（同前）：AI 视觉估真实高度并缩放；互斥同前 |
| `convert_format_only` | bool | 否 | — | ⚠ 已废弃：true 时仅转换格式、忽略 topology / resize_height / target_polycount 等；必须同时提供 `target_formats` |
| `alpha_thumbnail` | bool | 否 | `false` | 额外渲染透明背景 (RGBA) 缩略图 → `alpha_thumbnail_url` |

> 注意 `model_url` 的 Data URI MIME 必须为 `application/octet-stream`（不是 `image/*`）。
> 本地文件读入转 Data URI 即可提交，**无需公网 URL**（dsh-gen3d `gen3d_retopo_lowpoly`
> 的 meshy 路由即按此实现，见本条末尾注记）。

curl（Meshy 任务输入）：

```bash
curl https://api.meshy.ai/openapi/v1/remesh \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "input_task_id": "018b314a-...（已成功的 text-to-3d-preview / refine / image-to-3d / retexture 任务）",
    "target_polycount": 30000,
    "target_formats": ["glb"]
  }'
# => {"result": "018d...."}  (HTTP 202)
```

curl（外部模型，本地 GLB 转 Data URI）：

```bash
curl https://api.meshy.ai/openapi/v1/remesh \
  -X POST \
  -H "Authorization: Bearer ${MESHY_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model_url": "data:application/octet-stream;base64,<base64 编码的 GLB 文件内容>",
    "topology": "quad"
  }'
```

### 6.2 查询 / 删除 / 列表 / SSE

`GET /openapi/v1/remesh/:id` 轮询（终态即停）；另有 `DELETE /openapi/v1/remesh/:id`
（永久删除任务与全部关联数据）、`GET /openapi/v1/remesh`（分页列表，
`page_num` / `page_size` / `sort_by` 同 §0）、`GET /openapi/v1/remesh/:id/stream`
（SSE 实时进度，PENDING / IN_PROGRESS 时只推必要字段）。

### 6.3 Remesh 任务对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `type` | string | `type` 恒为 `remesh` |
| `model_urls` | object | 重拓扑后模型下载 URL 集合；未生成的格式**字段被省略**而非空串 |
| `model_urls.glb` / `.fbx` / `.obj` / `.usdz` / `.blend` / `.stl` / `.3mf` | string | 各格式下载 URL（`blend` 为 Blender 文件；`3mf` 仅在显式请求时存在） |
| `thumbnail_url` | string | 从重拓扑后模型渲染的预览图下载 URL |
| `alpha_thumbnail_url` | string | RGBA 透明版缩略图（仅 `alpha_thumbnail: true` 且成功渲染时存在） |
| `progress` / `status` | — | `status` 官方列举为 PENDING / IN_PROGRESS / SUCCEEDED / FAILED（无 CANCELED） |
| `created_at` / `started_at` / `finished_at` | timestamp | 同通用（毫秒 epoch；未开始/未完成时为 0） |
| `preceding_tasks` | int | 排队中前面的任务数（仅 PENDING 时有意义） |
| `task_error` / `consumed_credits` | — | 同通用（失败退费，见 §0） |

### 6.4 失败模式

- `400 Bad Request`：缺参（model_url / input_task_id 均未提供）、输入任务无效
  （未引用支持模型、非 SUCCEEDED）、模型格式扩展名不支持、URL 不可访问、
  topology 非法、互斥参数冲突（如 auto_size 与 resize_height 同设）。
- `401 Unauthorized`：API key 无效。
- `402 Payment Required`：积分不足。
- `429 Too Many Requests`：超速率限制。

> **dsh-gen3d 已实现**：`gen3d_retopo_lowpoly` 的 `provider=meshy` 路由即本端点——
> Meshy 生成的资产经 sidecar `custom.meshyTaskRefs.resultTaskId`（或显式
> `originalTaskId`）走 `input_task_id`；本地任意 GLB 读文件转 Data URI
> （`application/octet-stream`）作 `model_url`，**无需公网 URL**。参数映射：
> `targetPolycount` → `target_polycount`（100–300,000）、
> `detailLevel` → `decimation_mode`（high→2 / medium→3 / low→4，与
> `targetPolycount` 互斥、`targetPolycount` 优先）、
> `polygonType` → `topology`（quadrilateral→quad）。5 积分 / 次。

---

## 7. 新增端点与页面（2026-08）——官方地图（dsh-gen3d 未实现）

> 以下端点 / 页面均为官方文档已收录、但 dsh-gen3d 的 meshy provider **未实现**
> （已实现范围：v2 text-to-3d、v1 image-to-3d / multi-image-to-3d、rigging、
> animations、remesh（§6，`gen3d_retopo_lowpoly` 的 meshy 路由）与 balance，
> 即本文档 §2–§6 与 §8）。本节仅作能力地图，
> 细节以各官方页面为准；若后续实现，参数以官方页面（或 llms-full.txt）为准逐一核对。

### 7.1 新增/独立端点（官方文档已单独成页）

| 端点 | 路径 | 备注 |
|---|---|---|
| ~~Remesh~~（已实现） | `POST /openapi/v1/remesh` | ✅ **已实现**：`gen3d_retopo_lowpoly` 的 `provider=meshy` 路由，详见 §6；convert/resize 已拆独立端点，Remesh 上的旧参数仍兼容（2026-05-22） |
| Convert | `POST /openapi/v1/convert` | 格式转换（2026-05-22 自 Remesh 拆出） |
| Resize | `POST /openapi/v1/resize` | 按高度/最长边缩放（2026-05-22 拆出；`resize_longest_side` 2026-05-12 加入） |
| UV Unwrap | `POST /openapi/v1/uv-unwrap` | 生成新 UV 布局（2026-06-15 新增；≤40,000 面，超出先 Remesh；5 积分） |
| Retexture | `POST /openapi/v1/retexture` | 模型重贴图；**旧 Text to Texture 路径已下线**——无鉴权探测对照：`/openapi/v1/text-to-texture` 返回 404，`/openapi/v1/retexture` 返回 401（端点存在与否即此区分） |
| Text to Image / Image to Image | `POST /openapi/v1/text-to-image`、`POST /openapi/v1/image-to-image` | 图片生成/编辑（2025-12-31 新增；`remove_background` 2026-08-17 加入） |
| Multi-Color Print | `POST /openapi/v1/print/multi-color` | 转多色 3MF（1–16 色板，10 积分；`style` 参数 2026-08-20 加入） |
| Analyze / Repair Printability | `POST /openapi/v1/print/analyze`、`POST /openapi/v1/print/repair` | FDM 可打印性分析（免费）/ 修复（10 积分）；2026-05-07 新增 |
| Creative Lab 系列 | `/openapi/creative-lab/<product>/v1/{prototype,build}` | Keychain / Fridge Magnet / Figure / Vinyl Figure / Brick Figure / Keycap / Lamp；prototype（6 积分）→ build（30–50 积分）两段链式（`input_task_id` 串联），产品级 URL 各自版本线 |

### 7.2 新增页面（非端点）

- [Asset Retention](https://docs.meshy.ai/en/api/asset-retention)：API 资产非 Enterprise 默认保留 3 天，Enterprise 无限保留（§0）。
- [Pricing](https://docs.meshy.ai/en/api/pricing)：各端点积分表（Animation 3 积分、Smart Topology preview 5 积分、8K 贴图 15 积分、Remesh 5 积分等）。
- [Webhooks](https://docs.meshy.ai/en/api/webhooks)：任务状态回调（省轮询）。
- [Changelog](https://docs.meshy.ai/en/api/changelog)：本文档各字段的变更史（2026-08-13/18/20 条目即本次对齐依据；2026-08-24 条目为 gpt-image-2 的 aspect_ratio 扩展——仅 Text to Image / Image to Image API，本插件未实现，仅此处地图注记）。
- [AI Integration](https://docs.meshy.ai/en/api/ai)（MCP）：官方 MCP 服务器 `@meshy-ai/meshy-mcp-server`。
- [API Playground](https://docs.meshy.ai/en/api/playground)：交互式控制台（2026-06-17 起文档可用，Pro 及以上计划）。

### 7.3 与本插件的关系

- 本节除 Remesh（已实现，见 §6）外端点均未实现，仅作地图：`gen3d_retopo_lowpoly`
  除 meshy 路由外仍走 hunyuan3d / tripo3d 供应商路由（见 [KNOWN-GAPS](../KNOWN-GAPS.md) #3）；
  Meshy 侧其余降面/重贴图（Convert / Resize / UV Unwrap / Retexture）是后续若要补齐的
  候选路由，路径以上表为准。
- 结论清单中“官方文档未记载、勿依赖”的条目按本节澄清（§10 结论 7）。

---

## 8. 余额 / 配额 / 速率限制

### 8.1 余额查询

`GET /openapi/v1/balance`（[Balance](https://docs.meshy.ai/en/api/balance)），返回 `{"balance": <int>}`，即当前剩余积分。

```bash
curl https://api.meshy.ai/openapi/v1/balance \
  -H "Authorization: Bearer ${MESHY_API_KEY}"
# => {"balance": 1000}
```

> 官方**没有**“积分消耗明细/历史”端点（官方文档未记载）。单任务消耗可从任务对象的 `consumed_credits` 得知。

### 8.2 速率限制（[Rate Limits](https://docs.meshy.ai/en/api/rate-limits)）

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

### 8.3 官方定价快照（2026-08-24，[Pricing](https://docs.meshy.ai/zh/api/pricing)）

> 预付费积分制；以下为官方定价页当日快照（官方注明可能变动，以定价页为准）。
> 插件侧 `billing.credits` 已按本表对齐（审批 gate 展示预计消耗）。

| API | 积分/次 |
|---|---|
| Text to 3D Preview（网格） | meshy-6/低面数模型 20；**meshy-7 20**（`ultra_mode` 另 +5）；smart-topology（meshy-t2）5；其他（meshy-5）5 |
| Text to 3D Refine（贴图） | 10（texture_resolution 2k/4k）；15（8k） |
| Image to 3D | meshy-6/7：20（无纹理）/ 30（有纹理）/ 35（8K），`ultra_mode` 另 +5；meshy-t1 同档；meshy-t2：5/15/20；其他：5/15 |
| Multi-Image to 3D | meshy-6/7：20/30/35（同 Image to 3D）；其他：5/15 |
| Retexture | 10（2k/4k）；15（8k） |
| **Remesh** | **5** |
| Convert / Resize | 各 1 |
| **Auto Rigging（绑骨）** | **5** |
| **Animation（套动作）** | **3** |
| Text/Image to Image | 3–12（nano-banana / gpt-image-2 分档；本插件未实现） |
| 多色打印 / 可打印性修复 | 各 10；可打印性分析免费 |
| 创意工坊（7 产品） | Prototype 6（键帽 12）；Build 30（键帽 50） |

参考换算：一个「文生 + 绑骨 + 一个动作」的角色全链约 **38 积分**（30 + 5 + 3）。

---

## 9. 错误码格式（[Errors](https://docs.meshy.ai/en/api/errors)）

两类错误：

### 9.1 请求级错误（HTTP 状态码即时返回）

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
| 429 Too Many Requests | 超速率限制（见 §8.2） |
| 5xx | 服务端错误（看官方状态页/Discord） |

### 9.2 任务级错误（`task_error` 对象，轮询时在任务响应中）

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

## 10. 对 DSH 迁移的关键结论

1. **认证**：Bearer key 由用户在官网 API settings 页自建（meshy.ai 账号），天然适配 DSH 的 credentials 机制（环境变量 / `$DSH_HOME/.credentials.yaml`——⚠ DSH host 0.1.1-rc.2 起该文件为 host 接管的版本化格式，插件读不到 `refs:` 下的键，本机 key 请走环境变量或 `$DSH_HOME/.env`，见 docs/CREDENTIALS.md §3.1），插件不内置 key；未配置时回退 mock 与余额预检（`GET /openapi/v1/balance` 免费、不计队列）。
2. **任务异步模型**：所有能力都是 create → poll → download 三步。DSH 的 `ctx.jobs` 长任务模式正好对应；SSE `/stream` 可选但非必需（轮询即可）。
3. **计费预检**：创建前可用 `GET /openapi/v1/balance` 检查余额；`402` 表示余额不足；`429` 需区分 `RateLimitExceeded`（限频退避）与 `NoMoreConcurrentTasks`（队列满，等待而非重试）。
4. **两阶段文生 3D**：`mode: preview`（几何）→ `mode: refine`（贴图）；`texture_image_url` 支持 base64 Data URI，可避免外网 URL 依赖。
5. **绑骨/动作**：rigging 输出自带 walk/run（`basic_animations`）；Animation 按 `rig_task_id + action_id` 执行；动作目录以官方免鉴权 JSON 为准（§5.3：total 680、id -2~696、90 条 `_inplace`、22 条 `isFree: true`），需随包固化静态目录（本包 ~680 条）。
6. **下载**：资产 URL 带签名且有过期时间（`expires_at`），必须立即下载；文件格式用 `target_formats` 显式限定以减少任务耗时。
7. **官方文档未记载、勿依赖**：Text to 3D 任务对象的 `expires_at`；rigging 的显式参数（如 `generate_basic_animations` / `enable_animation` / `animation_action_id`、`rig_type`）；动作目录的「创建/管理动作」认证 API（官方仅有免鉴权只读 JSON 目录，§5.3）；积分消费明细端点（余额只有总额）。API key 格式官方已有记载（`msy_<随机串>`，§1，注意下划线）。本文档分工（生成为主）未展开的端点见 §7。
8. **低模 / 重拓扑路径**：官方路径有两类——① Text to 3D（§2.1）与 Image to 3D（§3.1）的 `model_type: smart-topology`（`meshy-t2` + `target_polycount`，Text to 3D preview 5 积分），`model_type: lowpoly` 已废弃；② 独立 Remesh API（§6）——**dsh-gen3d 已实现**（`gen3d_retopo_lowpoly` 的 `provider=meshy` 路由）：Meshy 任务经 `input_task_id`，本地任意 GLB 读文件转 Data URI（`application/octet-stream`）作 `model_url`，**本地 GLB 经 Data URI 可直接重拓扑，无需公网 URL**（5 积分 / 次）。
