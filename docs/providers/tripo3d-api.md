# Tripo3D 官方 API 协议文档（DSH 迁移参考）

> 本文档基于 Tripo3D（VAST）官方文档站点 **docs.tripo3d.ai**（国际站 v2 协议）与 **developers.tripo3d.ai / developers.tripo3d.com**（新 v3 协议门户）实际抓取整理，不含任何第三方网关包装的字段。
> 抓取日期：2026-08-13。官方文档为英文，本文为中文转述 + 字段直译；官方字段名一律保留原样。
>
> 来源 URL（均为官方）：
> - 文档站首页 / Quick Start：https://docs.tripo3d.ai/ 、https://docs.tripo3d.ai/get-started/quick-start.html
> - 能力总览：https://docs.tripo3d.ai/get-started/overview.html
> - 定价：https://docs.tripo3d.ai/get-started/pricing.html
> - 限速：https://docs.tripo3d.ai/get-started/rate-limits.html
> - 错误码：https://docs.tripo3d.ai/get-started/errors-and-error-handling.html
> - 更新日志：https://docs.tripo3d.ai/get-started/changelog.html
> - 任务查询：https://docs.tripo3d.ai/task-query/get-your-task-result.html
> - 上传（直传 / STS）：https://docs.tripo3d.ai/file-upload/quick-upload-directly.html 、https://docs.tripo3d.ai/file-upload/upload-in-sts.html
> - 文生 3D H3/H2/P1：https://docs.tripo3d.ai/model-generation/text-to-model-v3-0-v3-1.html 、text-to-model-v2-0-v2-5.html 、text-to-model-p1-20260311.html
> - 图生 3D H3/H2/P1：https://docs.tripo3d.ai/model-generation/image-to-model-v3-0-v3-1.html 、image-to-model-v2-0-v2-5.html 、image-to-model-p1-20260311.html
> - 多视图生 3D H3/H2/P1：https://docs.tripo3d.ai/model-generation/multiview-to-model-v3-0-v3-1.html 、multiview-to-model-v2-0-v2-5.html 、multiview-to-model-p1-20260311.html
> - 模型导入：https://docs.tripo3d.ai/model-generation/import-model.html
> - 贴图：https://docs.tripo3d.ai/texture/texture-model-v3-0-20250812.html 、texture-model-v2-5-20250123.html
> - 智能低模 / 分割 / 补全：https://docs.tripo3d.ai/mesh-editing/smart-low-poly-p-v2-0-20251225.html 、mesh-segmentation-v1-0-20250506.html 、mesh-completion-v1-0-20250506.html
> - 绑骨 v2.5/v2.0 / 预检：https://docs.tripo3d.ai/animation/rig-v2-5-20260210.html 、rig-v2-0-20250506.html 、pre-rig-check-v2-0-20250506.html
> - 套动作：https://docs.tripo3d.ai/animation/retarget.html
> - 格式转换：https://docs.tripo3d.ai/export/conversion.html
> - 多视图图像生成：https://docs.tripo3d.ai/image-generation/multiview-image.html
> - FAQ：https://docs.tripo3d.ai/other/support-faq.html
> - v3 新协议门户（国际 / 国内）：https://developers.tripo3d.ai/en/docs 、https://developers.tripo3d.com/en/docs
> - 官方 Python SDK：https://github.com/VAST-AI-Research/tripo-python-sdk

---

## 0. 总览

- **Base URL（v2 协议，国际站）**：`https://api.tripo3d.ai/v2/openapi`。请求体 JSON，响应 JSON。
- **认证**：`Authorization: Bearer <API Key>` 头（见 §1）。
- **统一响应包装**：所有端点返回 `{"code": 0, "data": {...}}`；失败返回 `{"code": <非0>, "message": "...", "suggestion": "..."}`（见 §14）。HTTP 状态码与 JSON `code` 同时存在，两者都要判断。
- **任务模型**：**异步任务制**。所有生成类能力共用一个端点 `POST /v2/openapi/task`，靠请求体 `type` 字段区分任务类型（`text_to_model` / `image_to_model` / `multiview_to_model` / `texture_model` / `animate_rig` / `animate_retarget` / …）；创建返回 `data.task_id` → 轮询 `GET /v2/openapi/task/{task_id}` 直到 `status: success` → 从 `data.output` 的 URL 下载资产。
- **任务状态机**（8 态，官方 [Get your task result](https://docs.tripo3d.ai/task-query/get-your-task-result.html)）：
  - 进行中：`queued`（排队中，progress=0）、`running`（执行中）；
  - 终态：`success`、`failed`、`banned`（违反内容政策）、`expired`、`cancelled`、`unknown`（系统级异常，需带 task_id 联系支持）。
- 任务查询**必须使用创建任务的同一个 API key**（同一账号的其他 key 也会返回 "task not found"）。
- 失败任务**不消耗积分**；已扣的会退款（FAQ §6）。
- 所有响应头带 `X-Tripo-Trace-ID`（UUID，每请求随机），排障时需上报该值（§14）。
- **下载 URL 有时效**：任务查询文档称默认 **5 分钟**后过期；FAQ 第 10 条称下载时遇 403 是因为链接仅 **60 秒**有效，过期需重新查询任务拿新链接——**两处官方记载不一致，实现上应「查询后立即下载，失败重新查询再取链接」**。
- **v3 新协议并存**：VAST 正在并行发布资源化 REST 风格的新协议（国际 `https://openapi.tripo3d.ai/v3`、国内 `https://openapi.tripo3d.com/v3`，文档在 developers.tripo3d.ai / developers.tripo3d.com），官方 SDK 目前仅对 mesh segmentation v2 使用 v3 通道，其余仍走 v2。**本文档以 v2/openapi 为正式对接协议，v3 见 §15（仅列端点面，未逐字段核实）。**

curl 约定：下文 curl 均取自官方文档的 cUrl 示例（官方示例按此风格编写），仅将 `tsk_***` 替换为 `${TRIPO3D_API_KEY}` 环境变量写法。

---

## 1. 认证方式（API Key）

官方（[Quick Start](https://docs.tripo3d.ai/get-started/quick-start.html)）：

1. 在 platform.tripo3d.ai 注册账号，打开 **API key 页面**（https://platform.tripo3d.ai/api-keys ）生成 key。
2. key 字符串以 **`tsk_` 开头**（官方文档示例 `tsk_***`；官方 FAQ 明确 "The API key starts with `tsk_`"）。
3. 每个请求带 `Authorization: Bearer <API_KEY>` 头。
4. **注意区分 API Key 与 Client ID**：Client ID 以 `tcli_` 开头，仅用于标识应用，**不做认证**；拿 Client ID 去请求会全部 401（FAQ 第 12 条）。
5. 官方 SDK 从环境变量 `TRIPO_API_KEY` 读取 key；DSH 侧按公共约定走 `readProviderKey('tripo3d')`（对应 `TRIPO3D_API_KEY`），不直接读 env。

> 官方文档**未记载** key 的创建入口以外的细节（如是否只显示一次、可否吊销）；以上仅说明「platform.tripo3d.ai 的 API key 页面」为获取入口。

---

## 2. 文生 3D：`text_to_model`

单端点、单任务出成品（**无 Meshy 那种 preview/refine 两阶段**）。同一任务一次产出最多三份下载物（`model` 带贴图模型、`base_model` 无贴图模型、`pbr_model` PBR 模型，见 §6）。

### 2.1 模型版本（三产品线）

| 产品线 | model_version | 定位 | 默认面数上限（标准 / Ultra） |
|---|---|---|---|
| H3 | `v3.1-20260211`（最新）/ `v3.0-20250812` | 高保真、全参数 | 150 万 / 200 万（v3.1）；100 万 / 150 万（v3.0） |
| H2 | `v2.5-20250123`（默认）/ `v2.0-20240919` | 稳定 2.x 基线，参数与 H3 基本一致 | — |
| P1 | `P1-20260311` | 低模 / 结构化网格（Smart Mesh，约 2 秒出网格） | 自适应，face_limit 48–20000 |

- 省略 `model_version` 时，H2 页面称"general generation reference"默认 `v2.5-20250123`（该「通用生成参考」独立页面**未在文档站导航中出现**，官方未单列；以 H2 页面记载为准）。
- 已废弃版本：`v1.4-20240625` 及更早（传旧版本返回错误码 2015）。`Turbo-v1.0-20250506`（快速版）仍可用但文档站已不单列参数页。

### 2.2 必填参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `type` | string | 必须为 `"text_to_model"` |
| `prompt` | string | 文本描述，**最长 1024 字符**（约 100 词）；支持多语言；**不支持 emoji 与部分特殊 Unicode 字符** |
| `model_version` | string | 见 §2.1（官方示例均显式传入） |

### 2.3 公共参数（H2/H3 通用，P1 仅子集）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `negative_prompt` | string | — | 反向提示，最长 255 字符 |
| `image_seed` | int | 随机 | 内部「文生参考图」阶段的随机种子 |
| `model_seed` | int | 随机 | 几何生成种子（≥v2.0-20240919 / Turbo 有效）；同 seed 得到相同模型 |
| `texture` | bool | `true` | 是否生成贴图；`false` 时**少 10 积分**（v1.4 无效） |
| `texture_seed` | int | 随机 | 贴图生成种子（≥v2.0 / Turbo 有效）；同 `model_seed` + 不同 `texture_seed` 换贴图 |
| `texture_quality` | string | `standard` | `detailed` 高清贴图，**+10 积分**；组合规则见 §2.5 |
| `pbr` | bool | `true` | 是否生成 PBR 材质；置 `true` 时 `texture` 被忽略并强制为 true |
| `smart_low_poly` | bool | `false` | 手工程拓扑的低模网格，**+10 积分**；复杂模型有失败可能 |
| `quad` | bool | `false` | 四边形网格输出（**强制输出 FBX**），**+5 积分**；`face_limit` 缺省时默认 10000，建议 ≤150,000 |
| `face_limit` | int | 自适应 | 输出面数上限；`smart_low_poly=true` 时 1000–20000，同时 `quad=true` 时 500–10000 |
| `auto_size` | bool | `false` | 按真实尺寸（米）缩放；**仅贴图模型可用** |
| `compress` | string | meshopt | `geometry` = 几何压缩 |
| `generate_parts` | bool | `false` | 分段生成（可编辑部件），**+20 积分**；**不兼容** texture/pbr=true 与 quad=true |
| `export_uv` | bool | `true` | 生成时 UV 展开；`false` 提速减体积（UV 留给贴图阶段） |
| `geometry_quality` | string | `standard` | **仅 H3**：`detailed` = Ultra 模式（最高细节），**+20 积分** |

### 2.4 创建任务

`POST /v2/openapi/task`（官方 [Text to model (H3)](https://docs.tripo3d.ai/model-generation/text-to-model-v3-0-v3-1.html) 示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"text_to_model","prompt":"a stylized wooden chair","model_version":"v3.1-20260211"}'
unset APIKEY
# => {"code":0,"data":{"task_id":"1ec04ced-4b87-44f6-a296-beee80777941"}}
```

进阶示例（官方）：`{"prompt":"A futuristic sci-fi helmet with glowing blue visor.","model_version":"v3.1-20260211","face_limit":80000,"geometry_quality":"detailed","auto_size":true}`。

### 2.5 `texture_quality=detailed` 组合规则（官方原样，H2/H3/P1/贴图任务通用）

| texture | pbr | 效果 |
|---|---|---|
| false | false | 贴图升到 **4K**（仅 v3.0-20250812 可用） |
| false | true | 在当前贴图基础上生成 PBR |
| true | false | 重新生成 HD 贴图（无 PBR） |
| true | true | 重新生成 HD 贴图 + PBR |

⚠ `texture_quality=standard` 且 `texture=false`、`pbr=false` 组合**不允许**（官方 Warning）。

---

## 3. 图生 3D：`image_to_model`

### 3.1 图片输入方式（三种，官方 [Image to model (H3)](https://docs.tripo3d.ai/model-generation/image-to-model-v3-0-v3-1.html)）

| 输入 | 说明 |
|---|---|
| `file.file_token` | 上传返回的 token（`POST /upload/sts` 直传，见 §5.1），与 url/object 互斥 |
| `file.url` | **图片直链 URL**，仅 JPEG/PNG，≤20MB，与 file_token/object 互斥 |
| `file.object`（官方标记 Strongly Recommended） | STS 上传返回的 `{bucket, key}`（bucket 通常 `tripo-data`，key 为 resource_uri），与 url/file_token 互斥 |

> **官方文档未记载 base64 Data URI 输入**（与 Meshy 的 `data:image/...` 不同）。DSH 集成时若参考图是本地文件，须先走上传端点（§5），不能直接塞 base64。

### 3.2 参数

必填：`type: "image_to_model"`、`file`（见上）、`model_version`（同 §2.1 三产品线）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `model_seed` | int | 随机 | 同 §2.3 |
| `enable_image_autofix` | bool | `false` | 自动优化输入图（模糊/信息缺失），耗时更长 |
| `texture` | bool | `true` | 同 §2.3 |
| `texture_seed` / `texture_quality` / `texture_alignment` | — | — | `texture_alignment`：`original_image`（默认，贴合原图）/ `geometry`（贴合几何） |
| `pbr` / `smart_low_poly` / `quad` / `face_limit` / `auto_size` / `compress` / `generate_parts` / `export_uv` / `geometry_quality` | — | — | 同 §2.3 |
| `orientation` | string | `default` | `align_image` = 自动旋转模型对齐原图；**仅 texture=true 时生效** |

curl（官方示例，file_token 方式）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"image_to_model","file":{"type":"image","file_token":"ce85f375-3ccc-440b-b847-571588872ec2"},"model_version":"v3.1-20260211"}'
unset APIKEY
```

url 方式：`"file":{"type":"image","url":"https://example.com/hero.png"}`。

---

## 4. 多视图生 3D：`multiview_to_model` 与多视图图像生成

### 4.1 multiview_to_model

必填：`type: "multiview_to_model"`、`files` 或 `original_task_id`（**互斥**）、`model_version`。

- `files`：**必须恰好 4 项**，顺序固定 `[front, left, back, right]`；可省略部分输入（省略该项的 file_token），但 **front 不可省略**；**少于 2 张不允许生成**。每项是 §3.1 的 file 对象。
- `original_task_id`（v1.9.6+）：直接引用 `generate_multiview_image` / `edit_multiview_image` 任务的输出，免重复上传（仅支持这两类任务的输出）。
- 其余参数与 `image_to_model` 相同（`model_seed` / `enable_image_autofix` / `texture` / `texture_*` / `pbr` / `smart_low_poly` / `quad` / `face_limit` / `auto_size` / `orientation` / `compress` / `generate_parts` / `export_uv` / `geometry_quality`(H3)）。

curl（官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"multiview_to_model","files":[{"type":"image","file_token":"11111111-1111-4111-8111-111111111111"},{"type":"image","file_token":"22222222-2222-4222-8222-222222222222"},{"type":"image","file_token":"33333333-3333-4333-8333-333333333333"},{"type":"image","file_token":"44444444-4444-4444-8444-444444444444"}],"model_version":"v3.1-20260211"}'
unset APIKEY
```

### 4.2 多视图图像生成（单图 → 四视图，供下游生 3D）

`type: "generate_multiview_image"`：输入 `file`（§3.1 三选一），输出四张固定视角图 front/left/back/right（见 §6 的 `generate_multiview_image` 输出字段）。10 积分/次；**并发上限 1**。

`type: "edit_multiview_image"`：对已生成的四视图做局部编辑。必填 `original_task_id`（须为 generate_multiview_image 任务）+ `prompts` 数组：`{"prompt": "add a hat", "view": "front"}`，view 取值 front/left/back/right。5 积分/视角；**并发上限 1**。

> 注意：这里「多视图」与 Meshy 的「Multi-Image to 3D（1–4 张任选）」不同——Tripo 固定 4 视图顺序且 front 必填。

---

## 5. 文件上传

图片输入走两个上传端点之一（均不消耗生成积分）：

### 5.1 直传：`POST /v2/openapi/upload/sts`

- 请求体 **multipart/form-data**，字段 `file`。
- **仅图片**：webp / jpeg / png（**不支持模型文件**）。
- ≤20MB，通常几秒完成。
- 返回 `data.image_token`（作为 file_token 使用）。

```bash
curl -X POST 'https://api.tripo3d.ai/v2/openapi/upload/sts' \
  -H "Authorization: Bearer ${APIKEY}" \
  -F 'file=@character.png'
# => {"code":0,"data":{"image_token":"ce85f375-3ccc-440b-b847-571588872ec2"}}
```

### 5.2 STS 临时凭证：`POST /v2/openapi/upload/sts/token`

先取 STS 凭证，再直传 S3（官方推荐方式，适合大文件）：

```bash
curl -X POST 'https://api.tripo3d.ai/v2/openapi/upload/sts/token' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"format":"png"}'
# => {"code":0,"data":{
#   "s3_host":"s3.us-west-2.amazonaws.com",
#   "resource_bucket":"tripo-data",
#   "resource_uri":"<目标路径>",
#   "session_token":"...","sts_ak":"...","sts_sk":"..."}}
```

- `format`：图片 webp/jpeg/png；**3D 模型 glb/obj/fbx/stl**（模型只能走 STS 路径，且 import_model 页称模型须 <150MB；而 upload/sts/token 页面称文件 ≤20MB——**两处上限记载不一致**，以各自页面为准并留待实测）。
- 拿到凭证后用 AWS S3 PUT（带 `session_token`/`sts_ak`/`sts_sk`）上传到 `s3_host` 桶 `resource_bucket` 的 `resource_uri`；生成任务里 `file.object = {bucket, key: resource_uri}`。

---

## 6. 任务查询与轮询

`GET /v2/openapi/task/{task_id}`（官方 [Get your task result](https://docs.tripo3d.ai/task-query/get-your-task-result.html)）：

```bash
curl https://api.tripo3d.ai/v2/openapi/task/ef731ad6-aeb0-4950-9a2e-2298359dfaf8 \
  -H "Authorization: Bearer ${APIKEY}"
```

响应 `data` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 任务 id（UUID 格式，官方示例） |
| `type` | string | 任务类型（创建时传入的 type） |
| `status` | string | 8 态状态机（§0）；`success` 后 `output` 可用 |
| `progress` | int | 0–100；queued=0、success=100 |
| `input` | object | 创建时的输入回显 |
| `output` | object | 结果下载物（见下）；**可能含未记载的额外字段，勿依赖** |
| `consumed_credit` | int | 本任务消耗积分；失败为 0 |
| `queuing_num` | int | 排队位置；不在队列为 -1 |
| `running_left_time` | int | 预计剩余秒数；终态为 -1 |
| `create_time` | int | 创建时间戳（秒级 epoch，官方示例） |
| `error_code` | int | 失败时出现（见 §14） |

`output` 下载物字段（官方文档）：

| 字段 | 说明 |
|---|---|
| `model` | 带贴图的模型下载 URL（默认 5 分钟过期，FAQ 称 60 秒——见 §0） |
| `base_model` | 无贴图基础模型 URL |
| `pbr_model` | PBR 模型 URL |
| `generated_image` | 生成的图像 URL（图像类任务） |
| `rendered_image` | 模型预览渲染图 URL |
| `generate_multiview_image` | 仅 generate/edit_multiview_image 任务；含 `front_view_url` / `left_view_url` / `back_view_url` / `right_view_url`（固定顺序 front, left, back, right） |

官方轮询建议（Quick Start）：`poll_interval_seconds = 2`，`status == "success"` 即终止；失败看 `error_code`。

---

## 7. 绑骨（Auto Rig）

### 7.1 预检（免费）：`type: "animate_prerigcheck"`

输入 `original_model_task_id`（须为有模型输出的任务，1.x 版本任务不支持）。输出（任务 output）：`riggable`（bool）+ `rig_type`（**biped / quadruped / hexapod / octopod / avian / serpentine / aquatic** 七类）。

### 7.2 绑骨：`type: "animate_rig"`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `original_model_task_id` | string | — | 前置模型任务 id（≥v2.0-20240919 或 Turbo；1.x 不支持） |
| `out_format` | string | `glb` | `glb` 或 `fbx` |
| `model_version` | string | — | 最新 `v2.5-20260210`（2026-03-11 随 v3.1/P1 发布）；另有 v2.0-20250506、v1.0-20240301（legacy） |
| `rig_type` | string | `biped` | 骨架类型（同预检枚举） |
| `spec` | string | `tripo` | 绑骨算法：`mixamo` 或 `tripo` |

curl（官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"animate_rig","original_model_task_id":"ef731ad6-aeb0-4950-9a2e-2298359dfaf8","rig_type":"biped","model_version":"v2.5-20260210"}'
unset APIKEY
```

> 注意事项（官方 rig 页原样）：以下任务会重建/修改网格几何，输出**不保留**输入模型的骨骼与动画数据——重网格（Remesh）、开启 quad 或触发重拓扑的格式转换、智能低模（含 quad）、网格分割、网格补全。已绑骨/已套动作的模型应先完成所有网格编辑，再执行绑骨与套动作（或事后重跑）。

---

## 8. 套动作（动画）：`type: "animate_retarget"`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `original_model_task_id` | string | — | 已绑骨模型的任务 id（≥v2.0 / Turbo，1.x 不支持） |
| `out_format` | string | `glb` | `glb` 或 `fbx` |
| `bake_animation` | bool | `true` | 是否烘焙动画进模型；**仅 glb 可实现** |
| `export_with_geometry` | bool | `true` | 输出是否含几何 |
| `animation` | string | 二选一 | 单个预设动作（下表） |
| `animations` | string[] | 二选一 | 预设动作数组，**最多 5 个** |
| `animate_in_place` | bool | `false` | 是否原地（不位移）动画 |

**预设动作**（官方完整列表，即「动作库」）：

```
preset:idle  preset:walk  preset:run  preset:dive  preset:climb  preset:jump
preset:slash  preset:shoot  preset:hurt  preset:fall  preset:turn
preset:quadruped:walk  preset:hexapod:walk  preset:octopod:walk
preset:serpentine:march  preset:aquatic:march
```

> 官方**没有**「动作目录查询 API 端点」——预设列表就是上面这 16 个，直接固化在文档中。与 Meshy 的 0–696 大动作库不同。

curl（官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"animate_retarget","original_model_task_id":"ef731ad6-aeb0-4950-9a2e-2298359dfaf8","animation":"preset:walk"}'
unset APIKEY
```

---

## 9. 低模 / 重拓扑 / 网格编辑

四条官方路径，按需求选择：

1. **生成时一步到位**：`smart_low_poly: true`（H2/H3 生成参数，+10 积分，手工程拓扑低模；复杂模型有失败风险；face_limit 1000–20000，quad 同时开启 500–10000）。
2. **P1 产品线**（`P1-20260311`）：专门的结构化低模生成（文/图/多视图三入口），face_limit 48–20000，默认自适应。仅支持部分参数（不支持 quad / smart_low_poly / geometry_quality / generate_parts 等），传不支持的参数会报错。
3. **后处理智能低模**：`type: "highpoly_to_lowpoly"`（model_version `P-v2.0-20251225`），参数 `face_limit`（500–20000，quad 时 500–10000）、`quad`（开启强制 FBX）、`part_names`（仅处理指定分割部件）、`bake`（默认 true）。30 积分。
4. **格式转换时重拓扑**：`convert_model` 的 `quad` + `face_limit`（见 §11）。

配套网格编辑（与低模同属 mesh-editing 家族）：

- 网格分割 `type: "mesh_segmentation"`（v1.0-20250506）：语义部件分割，40 积分，输出部件名供 texture_model / highpoly_to_lowpoly / mesh_completion 的 `part_names` 使用。
- 网格补全 `type: "mesh_completion"`（v1.0-20250506）：把分割后编辑过的部件合并回完整模型，50 积分；模型须先经 mesh_segmentation。

curl（智能低模，官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"highpoly_to_lowpoly","original_model_task_id":"ef731ad6-aeb0-4950-9a2e-2298359dfaf8","face_limit":5000,"model_version":"P-v2.0-20251225"}'
unset APIKEY
```

---

## 10. 贴图精修：`type: "texture_model"`

对已有模型（≥v2.0 / Turbo 任务输出）重新生成贴图与 PBR。10 积分；`texture_quality=detailed` +10（4K 规则见 §2.5）。

| 参数 | 类型 | 说明 |
|---|---|---|
| `original_model_task_id` | string | 前置模型任务 id（1.x 不支持） |
| `texture_prompt` | object | **必填**，三选一：`text`（文本描述）/ `image`（单张参考图 file 对象）/ `images`（file 对象列表）；均可附加 `style_image`（艺术风格参考图） |
| `model_version` | string | `v3.0-20250812`（最新，4K 升级支持）/ `v2.5-20250123`（稳定版） |
| `texture` | bool | 默认 true；false 时仅更新 PBR（pbr=true） |
| `pbr` | bool | 默认 true |
| `texture_seed` / `texture_alignment` / `texture_quality` | — | 同 §2.3 / §3.2 |
| `part_names` | string[] | 只精修指定分割部件；默认全部 |
| `compress` | string | `geometry` 几何压缩 |
| `bake` | bool | 默认 true，把高级材质效果烘焙进基础贴图 |

curl（官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"texture_model","original_model_task_id":"ef731ad6-aeb0-4950-9a2e-2298359dfaf8","texture_prompt":{"text":"weathered bronze armor"},"model_version":"v3.0-20250812"}'
unset APIKEY
```

---

## 11. 格式转换：`type: "convert_model"`

版本无关，5 积分；以下参数每个 +5 积分：`quad=true`、`face_limit`、`flatten_bottom=true`、`flatten_bottom_threshold`、`texture_size`、`texture_format`、`pivot_to_center_bottom=true`、`scale_factor`。

- `format`：`GLTF` / `USDZ` / `FBX` / `OBJ` / `STL` / `3MF`。OBJ/STL/3MF **不支持绑骨模型**；3MF 仅导出几何；STL 不保留贴图；GLTF/STL 不支持四边面（quad 仍会重拓扑，但结果三角化）。
- 重拓扑相关：`quad`（quad remesh / 自动重拓扑）、`force_symmetry`（仅 quad 时生效）、`face_limit`（默认 10000）。
- 其它：`flatten_bottom`（默认 false）/ `flatten_bottom_threshold`（默认 0.01）、`texture_size`（默认 2048，≥v2.0 默认 4096）、`texture_format`（BMP/DPX/HDR/JPEG/OPEN_EXR/PNG/TARGA/TIFF/WEBP，默认 JPEG；FBX 默认 PNG）、`pivot_to_center_bottom`、`scale_factor`（默认 1）、`with_animation`（默认 true）、`pack_uv`（默认 false）、`bake`（默认 true）、`part_names`、`animate_in_place`（默认 false）、`export_vertex_colors`（仅 OBJ/GLTF）、`export_orientation`（默认 +x，支持 -x/-y/+y）、`fbx_preset`（实验性，blender 默认，支持 3dsmax/mixamo）。

curl（官方示例）：

```bash
export APIKEY="tsk_***"
curl -X POST 'https://api.tripo3d.ai/v2/openapi/task' -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${APIKEY}" \
  -d '{"type":"convert_model","original_model_task_id":"ef731ad6-aeb0-4950-9a2e-2298359dfaf8","format":"FBX"}'
unset APIKEY
```

---

## 12. 余额 / 配额 / 计费

### 12.1 余额查询

`GET /v2/openapi/user/balance`。**文档站 v2 页面未单列该端点**；路径与字段来自官方 SDK（[tripo-python-sdk `client.py`](https://github.com/VAST-AI-Research/tripo-python-sdk) 的 `get_balance()` → `GET /user/balance`，返回 `data.balance` 与 `data.frozen`）：

```bash
curl https://api.tripo3d.ai/v2/openapi/user/balance \
  -H "Authorization: Bearer ${APIKEY}"
# => {"code":0,"data":{"balance":123.0,"frozen":0.0}}
```

- `balance`：可用积分；`frozen`：进行中任务冻结的积分。
- 任务真实消耗以轮询响应的 `consumed_credit` 为准（官方定价页建议用此字段对账）。

### 12.2 计费（官方 [Pricing](https://docs.tripo3d.ai/get-started/pricing.html)）

- **先付费后使用**；`$1.00 = 100 credits`；注册赠送 300 免费积分（两周有效）；积分**永不过期**。
- 生成类：文生 3D 无贴图 10 / 带贴图 20（P1 为 30/40）；图生、多视图生 3D 无贴图 20 / 带贴图 30（P1 为 40/50）；`texture=false` 省 10 积分。
- 附加参数：`texture_quality=detailed` +10、`smart_low_poly=true` +10、`quad=true` +5、`generate_parts=true` +20、`geometry_quality=detailed` +20（**P1 一口价，不适用附加加价**）。
- 后处理：贴图 10（detailed +10）、分割 40、补全 50、智能低模 30、预检免费、绑骨 25、套动作 10/动画、格式转换 5（见 §11）。
- 图像：基础文生图 5；多视图图像生成 10；多视图编辑 5/视角。
- 失败任务不扣费（§0）。API 与网页版（Tripo Studio）是**两套独立计费**，积分不互通（FAQ 第 11 条）。

---

## 13. 限速（官方 [Rate limits](https://docs.tripo3d.ai/get-started/rate-limits.html)）

**并发限制**（按「并发组」统计，非按原始任务类型）：

| Task Scope | 并发上限 |
|---|---|
| text/image/multiview_to_model 且 model_version = `P1-20260311` | 5 |
| text/image/multiview_to_model 其它版本 | 10 |
| refine_model | 5 |
| animate_model / animate_prerigcheck / animate_rig / animate_retarget | 10 |
| generate_multiview_image / edit_multiview_image | 1 |
| 其他任务类型 | 10 |

- 例：非 P1 的 text_to_model 与 image_to_model 共享同一个并发桶。
- 超限返回 **429** + 错误码 **2000**，响应含 `Retry-After` 头；官方建议**指数退避**。
- 上传限速：**10 qps**（针对图片上传）。
- 默认并发上限 10（FAQ 第 4 条），企业可向官方申请提高。

---

## 14. 错误码（官方 [Errors](https://docs.tripo3d.ai/get-started/errors-and-error-handling.html)）

失败响应统一结构：`{"code": <int>, "message": "...", "suggestion": "..."}`；任务失败时轮询响应 `data` 里带 `error_code`。所有响应头含 `X-Tripo-Trace-ID`（UUID），排障上报时附上。

| HTTP | code | message（官方原文直译） | 建议 | DSH 映射（provider_*） |
|---|---|---|---|---|
| 500 | 1000 | 服务端未知错误 | 带 request id 联系支持 | provider_http_error（可重试） |
| 500 | 1001 | 服务端致命错误 | 同上 | provider_http_error（可重试） |
| 401 | 1002 | 认证失败（key 无效/错误） | 检查凭证（勿用 tcli_ Client ID） | provider_unauthorized |
| 400 | 1003 | 请求体格式错误 | 对照请求 schema | provider_bad_request |
| 400 | 1004 | 参数非法 | 查参数要求 | provider_bad_request |
| 403 | 1005 | 无权限访问该资源 | 检查权限 | provider_unauthorized |
| 429 | 1007 | 请求过于频繁（限频） | 稍等重试 | provider_rate_limited |
| 429 | 2000 | 超过生成并发上限 | 稍后重试，看 `Retry-After` 头 | provider_queue_full |
| 404 | 2001 | 任务不存在 | 检查任务是否由当前 key 创建、格式是否正确 | provider_bad_request |
| 400 | 2002 | 任务类型不支持 | 查支持的任务类型 | provider_bad_request |
| 400 | 2003 | 图片文件为空 | 检查文件 | provider_bad_request |
| 400 | 2004 | 图片类型不支持 | 用支持的类型（jpg/png/webp） | provider_bad_request |
| 400 | 2005 | draft 任务未成功 | 用成功的 draft 任务 | provider_bad_request |
| 400 | 2006 | 原任务类型不支持 | 用支持的任务 | provider_bad_request |
| 400 | 2007 | 原任务未成功 | 用成功的任务 | provider_bad_request |
| 400 | 2008 | 输入违反内容政策 | 修改输入重试 | provider_bad_request |
| 400 | 2009 | prompt 含非法字符 | 修改 prompt（勿用 emoji/特殊 Unicode） | provider_bad_request |
| 403 | 2010 | 积分不足 | 充值 | provider_insufficient_credits |
| 400 | 2011 | 预检任务的输入无模型输出 | 提供含模型输出的任务 | provider_bad_request |
| 400 | 2012 | 输入任务类型非法 | 提供绑骨任务 | provider_bad_request |
| 403 | 2013 | 优先级非法 | 需要更高优先级联系支持 | provider_bad_request |
| 400 | 2014 | 审核出错 | 联系支持 | provider_http_error |
| 400 | 2015 | 版本已废弃 | 用更高版本 | provider_bad_request |
| 400 | 2016 | 请求类型已废弃 | 用可用类型 | provider_bad_request |
| 400 | 2017 | 版本值非法 | 用正确版本 | provider_bad_request |
| 400 | 2018 | 模型过于复杂无法重网格 | 换模型 | provider_bad_request |
| 404 | 2019 | 文件未找到 | 确认上传成功 | provider_bad_request |

> 官方**未记载**网络层/超时类错误码（如任务运行超时）。HTTP 5xx 与网络错误按通用逻辑处理（`provider_timeout` / `provider_http_error` 可重试）。

---

## 15. v3 新协议（并存，未作为对接基线）

官方新门户 developers.tripo3d.ai（国际）/ developers.tripo3d.com（国内）文档的 v3 协议为**资源化 REST 风格**（不再是统一 `type` 任务端点），Base URL `https://openapi.tripo3d.ai/v3`（国际）/ `https://openapi.tripo3d.com/v3`（国内）。已核实端点面：

```
POST /v3/generation/text-to-model      POST /v3/generation/image-to-model
POST /v3/generation/multiview-to-model POST /v3/generation/text-to-image
POST /v3/generation/image-to-image     POST /v3/generation/image-to-multiview
POST /v3/generation/edit-multiview     POST /v3/generation/image-to-splat   (Gaussian Splat, 30积分/次, 约4分钟)
POST /v3/models/texture  /v3/models/convert  /v3/models/import
POST /v3/animations/rig  /v3/animations/rig-check  /v3/animations/retarget
POST /v3/mesh/segment  /v3/mesh/smartsegment  /v3/mesh/complete  /v3/mesh/decimate
POST /v3/files  GET /v3/files/presign（预签名直传，>60MB 推荐；multipart 上限 150MB）
GET  /v3/tasks/{task_id}  GET /v3/tasks/list
GET  /v3/account/balance（含 balance/frozen/按任务用量历史）
```

- v3 任务 id 形如 `task_abc123`（区别于 v2 的 UUID）；任务查询返回 `data.output.model_url / rendered_image_url` 等（SDK 内做 `model_url→model` 归一化映射）。
- v3 支持 **webhook**（task.completed / task.failed / balance.low，Settings → Webhooks，签名密钥 `whsec_…`）。
- 官方 SDK 目前仅 mesh segmentation v2（`v2.0-20260430`，`POST /v3/mesh/segment`，支持 `segmentation_granularity=simple/balanced/detailed`、`ref_image`、`split_by_connectivity`）走 v3 通道，其余全走 v2。
- **本文档未逐字段核实 v3 协议**（其文档为 SPA，字段级细节需另立分工抓取）。

---

## 16. 对 DSH 迁移的关键结论

1. **认证**：Bearer `tsk_` key，在 platform.tripo3d.ai 的 API key 页面自建，天然适配 DSH credentials（`TRIPO3D_API_KEY`，未配置回退 mock）。余额预检可用 `GET /v2/openapi/user/balance`（v2 文档站未单列但官方 SDK 在用）。
2. **异步模型与 Gen3dProvider 完全对齐**：`submitGeneration` = `POST /task`（type 按 mode 映射 `text→text_to_model`、`image→image_to_model`、`views→multiview_to_model`）；`pollTask` = `GET /task/{task_id}` 轮询，`success/failed/banned/expired/cancelled/unknown` 均为终态；`unknown/expired` 应上报原始响应。
3. **与 Meshy 的关键差异**：
   - 文生 3D **无 preview/refine 两阶段**，单任务同时出 `model` / `base_model` / `pbr_model`（对应 DSH `TaskDownloads.glb` + `previewImage`=rendered_image；`texture=false` 可省 10 积分）；
   - 图片输入**不支持 base64**，只有 file_token / url / object 三种；本地文件必须先上传（`/upload/sts` 直传，≤20MB，jpg/png/webp）；
   - **没有大动作库**，动画是 16 个固定 `preset:*` 预设（`listMotions` 可返回这 16 项静态目录）；
   - 多视图固定 4 视角 `[front,left,back,right]`（front 必填、≥2 张），`views` 模式须按此顺序组织参考图；
   - 任务查询**强绑定创建时的 API key**（换 key 报 2001 task not found）。
4. **绑骨/动画链**：`animate_prerigcheck`（免费，返回 riggable+rig_type，对应 DSH `submitRig` 前的预检可选步）→ `animate_rig`（`rig_type` biped/quadruped/…、`spec` tripo/mixamo，输出 glb/fbx）→ `animate_retarget`（`animation`/`animations` ≤5、`bake_animation`、`animate_in_place`）。注意网格编辑类任务（低模/分割/补全/重拓扑转换）会丢掉骨骼与动画，链路上应先编辑后绑骨。
5. **低模/重拓扑**：首选 P1 产品线或 `smart_low_poly=true` 一步生成（+10 积分）；后处理用 `highpoly_to_lowpoly`（face_limit 500–20000）；转换时 `quad+face_limit` 亦可重拓扑。`quad=true` 强制 FBX 输出。
6. **限速与退避**：并发按组统计（P1 生成 5、普通生成 10、多视图图像 1、其余 10）；429+2000 看 `Retry-After` 指数退避（映射 `provider_queue_full`）；429+1007 为限频（`provider_rate_limited`）；上传 10 qps。
7. **下载**：URL 带签名且短期有效（文档 5 分钟 / FAQ 60 秒不一致），**查询成功后立即下载，403 时重查任务再取新链接**；映射 `provider_empty_download`。
8. **官方文档未记载、勿依赖**：base64 图片输入；callback_url（v2 无，v3 才有 webhook）；动作目录 API（预设即 16 个）；「通用生成参考」默认版本页面（H2 页称缺省 v2.5-20250123）；上传大小上限（20MB vs 150MB 两处记载不一）；v3 协议字段级细节（另立分工核实）。
9. **建议默认模型版本**：文/图/多视图生成用 H3 `v3.1-20260211`；绑骨 `v2.5-20260210`；贴图 `v3.0-20250812`；智能低模 `P-v2.0-20251225`；低模生成需求走 `P1-20260311`。
