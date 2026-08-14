# Hunyuan3D（腾讯混元生3D）官方 API 调研协议

> 调研时间：2026-08-13。全部内容基于腾讯云官网文档实际抓取，来源 URL 见文末清单。
> 用途：dsh-gen3d 插件「Hunyuan3D 直连官方 API」接入方案的事实依据。所有字段以腾讯云官方文档为准，本文如与官方文档冲突，以官方为准。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| 认证方式 | 两条官方路径：**A. TokenHub 大模型服务平台**（API Key + `Authorization: Bearer`，OpenAI 兼容风格，官方主推）；**B. 腾讯云 API 3.0**（`SecretId`/`SecretKey` + TC3-HMAC-SHA256 签名，`ai3d.tencentcloudapi.com`） |
| 文生3D / 图生3D | 有。TokenHub `hy-3d-3.0` / `hy-3d-3.1`（submit/query 两接口）；腾讯云 API：`SubmitHunyuanTo3DProJob` / `QueryHunyuanTo3DProJob`（专业版，默认并发 3） |
| 多视图生3D | 有。专业版 `MultiViewImages` 参数（left/right/back；3.1 版另加 top/bottom/left_front/right_front 八视图） |
| 自动绑骨 | **有**。`SubmitAutoRiggingJob` / `DescribeAutoRiggingJob`（输入 T/A Pose 的 FBX/GLB ≤60MB，输出带骨骼 FBX，可选 48 个预设动作） |
| 动作/动画 | **有**。`SubmitHunyuanTo3DMotionJob`（文生动作，HY-Motion-1.0，Prompt→FBX 动画）；绑骨接口自带 48 个预设动作（MotionType）；另存在「人物模型3D动画」`SubmitCharacterToAnimationJob`（操作审计列出，公开 API 文档页未检索到，见 §3.3） |
| 姿态标准化 | 官方无独立「姿态标准化 API」。绑骨是**输入约束**（要求 A Pose / T Pose），不是服务。近似能力：`SubmitProfileTo3DJob`（真人头像+20 个模板生成人物） |
| 低模重拓扑 | **有**。`Submit3DSmartTopologyJob` / `Describe3DSmartTopologyJob`（智能拓扑，Polygon 1.5 模型，高模→低面数规整布线）；另有 `SubmitReduceFaceJob`（减面）与专业版 `GenerateType=LowPoly`（智能减面生成） |
| 质量评分 | 官方无此能力（需沿用原插件本地启发式评分） |
| GLB 动作合并导出 | 官方无此能力（需沿用本地 gltf-transform 合并逻辑；官方有 `SubmitConvert3DFormatJob`/`Convert3DFormat` 格式转换可作辅助） |
| 两阶段精修 | 官方无与 Meshy refine 直接对应的接口；纹理生成/纹理编辑可作近似替代（语义不同） |
| 价格 | 积分制：免费 100 积分；专业版 Normal 20 积分/次（LowPoly/Sketch 25、Geometry 15）；极速版 15 积分/次；智能拓扑 50；绑骨 10；文生动作 10；格式转换 5。后付费 0.12 元/积分日结 |
| 迁移注意 | 官方公告：混元大模型相关功能**逐步迁移至 TokenHub，原平台不再新增模型能力、停止新购模型服务**（已购继续可用）。新工程应首选 TokenHub 路径 |

---

## 1. 认证方式

### 1.1 路径 A：TokenHub 大模型服务平台（推荐）

- 官方 3D 接入文档：[大模型服务平台 TokenHub - 3D 生成](https://cloud.tencent.com/document/product/1823/130082)
- 鉴权头：`Authorization: Bearer <API_KEY>`（无 TC3 签名，最简单）
- API Key 来源：在 **TokenHub 控制台**创建 API Key（[混元调用指南](https://cloud.tencent.com/document/product/1823/132252)：「请将 YOUR_API_KEY 替换为您在 TokenHub 控制台创建的 API Key」）
- Base URL：
  - 提交任务：`https://tokenhub.tencentmaas.com/v1/api/3d/submit`
  - 查询任务：`https://tokenhub.tencentmaas.com/v1/api/3d/query`
- 模型名（小写带连字符）：`hy-3d-3.0`、`hy-3d-3.1`（专业版）、`hy-3d-express`（极速版）
- 参数风格：与腾讯云 API 3.0 同名参数，但**统一小写下划线**（如 `ResultFormat` → `result_format`）
- 覆盖范围：**仅生成类**（文生3D/图生3D/多视图生3D/白模/草图/智能拓扑生3D）。绑骨、文生动作、UV 展开、格式转换等**后处理接口未见 TokenHub 公开文档**，需走路径 B。

### 1.2 路径 B：腾讯云 API 3.0（TC3-HMAC-SHA256 签名）

- 国内域名：`ai3d.tencentcloudapi.com`，接口版本 `Version=2025-05-13`
- 国际域名：`hunyuan.intl.tencentcloudapi.com`，接口版本 `Version=2023-09-01`
- 凭证：腾讯云 API 密钥 `SecretId` + `SecretKey`（CAM 体系，控制台「访问管理 → API 密钥管理」创建）
- 签名：TC3-HMAC-SHA256（腾讯云标准签名 v3），官方文档：[签名方法 v3](https://cloud.tencent.com/document/product/1278/8530)。请求头携带 `X-TC-Action`、`X-TC-Version`、`X-TC-Region`、`Authorization`、`Content-Type: application/json`
- 能力面：生成类 + **全部后处理类**（绑骨、文生动作、智能拓扑、减面、UV、纹理、格式转换等）
- 实测路径建议：Node.js 工程直接用官方 SDK `tencentcloud-sdk-nodejs`（`Ai3d.V20250513.Client`），免手写签名；需要原生 fetch 直连时再手写 TC3（示例见 §6.2）

### 1.3 凭证接入 DSH 的建议（对应迁移决策）

- TokenHub 路径：DSH 凭证 `HUNYUAN_TOKENHUB_API_KEY`（环境变量 / `$DSH_HOME/.credentials.yaml`）→ 直接作为 Bearer
- 腾讯云 API 3.0 路径：`TENCENTCLOUD_SECRET_ID` + `TENCENTCLOUD_SECRET_KEY`（+ 可选 `TENCENTCLOUD_REGION`，默认 `ap-guangzhou`）
- 未配置 → 回退确定性 mock（沿用原设计）

---

## 2. 生成类接口（文生3D / 图生3D / 多视图生3D）

### 2.1 TokenHub 路径（submit / query）

来源：[TokenHub 3D 生成](https://cloud.tencent.com/document/product/1823/130082)

**提交（POST `https://tokenhub.tencentmaas.com/v1/api/3d/submit`）：**

```json
{
  "model": "hy-3d-3.0",
  "prompt": "一只小狗"
}
```

请求字段（`hy-3d-3.0` / `hy-3d-3.1` 与腾讯云「提交混元生3D专业版任务」一致；`hy-3d-express` 与「提交混元生3D极速版任务」一致，参数均为小写下划线）：

| 字段 | 必选 | 说明 |
|---|---|---|
| `model` | 是 | `hy-3d-3.0` / `hy-3d-3.1` / `hy-3d-express` |
| `prompt` | 与图二选一 | 文生3D 描述，中文正向提示词（专业版 ≤1024 utf-8 字符；极速版 ≤200） |
| `image_base64` / `image_url` | 与文二选一 | 图生3D。单边分辨率 128–5000；文件 ≤8MB（base64 后膨胀约 30%，建议原图 ≤6MB）；jpg/png/jpeg/webp |
| `multi_view_images` | 否 | 多视图生3D，数组，视角：`left`/`right`/`back`（3.1 另支持 `top`/`bottom`/`left_front`/`right_front`），每视角一张，jpg/png |
| `generate_type` | 否 | `Normal`（默认，带纹理）/ `LowPoly`（智能减面）/ `Geometry`（白模）/ `Sketch`（草图+prompt 可同传） |
| `enable_pbr` | 否 | PBR 材质，默认 false |
| `face_count` | 否 | 面数 3000–1500000，默认 500000（LowPoly 时不生效） |
| `polygon_type` | 否 | LowPoly 模式：`triangle`（默认）/ `quadrilateral` |
| `result_format` | 否 | 极速版：OBJ/GLB/STL/USDZ/FBX/MP4（默认 OBJ） |

响应（同步返回任务受理结果，**立即记下 `id`**）：

```json
{ "id": "14*******984", "request_id": "75********33", "object": "3d_job", "created_at": 1774806931, "status": "queued" }
```

**查询（POST `https://tokenhub.tencentmaas.com/v1/api/3d/query`）：**

```json
{ "model": "hy-3d-3.0", "id": "1429890795996585984" }
```

响应：

- 进行中：`{"status": "in_progress", ...}`（另有 `queued` 排队）
- 完成：`{"status": "completed", "data": [{"type": "obj", "url": "...", "preview_image_url": "..."}, {"type": "glb", "url": "...", "preview_image_url": "..."}]}`
- 轮询方式：官方未给出固定间隔，社区实践为每 3 秒轮询（[示例文章](https://cloud.tencent.com/developer/article/2722154)）；DSH 长任务建议 2–3s 间隔 + 超时重试

### 2.2 腾讯云 API 3.0 路径

#### 2.2.1 提交混元生3D专业版任务 `SubmitHunyuanTo3DProJob`

- 国内文档：[提交混元生3D专业版任务（1804/123447）](https://cloud.tencent.com/document/product/1804/123447)；国际版：[75540](https://www.tencentcloud.com/zh/document/product/1284/75540)
- 域名/版本：`ai3d.tencentcloudapi.com` + `2025-05-13`（国际 `hunyuan.intl.tencentcloudapi.com` + `2023-09-01`）
- 默认并发 **3**；频率限制 **20 次/秒**

请求参数：

| 参数 | 必选 | 类型 | 说明 |
|---|---|---|---|
| `Model` | 否 | String | `3.0`（默认）/ `3.1`。3.1 时 `GenerateType` 的 LowPoly、Sketch 不可用 |
| `Prompt` | 三选一 | String | 文生3D，中文正向提示词，≤1024 utf-8 字符；与图参数互斥 |
| `ImageBase64` | 三选一 | String | 图生3D；分辨率 128–5000；≤6MB 原图（base64 膨胀 30%）；jpg/png/jpeg/webp |
| `ImageUrl` | 三选一 | String | 图生3D；≤8MB |
| `MultiViewImages.N` | 否 | Array of ViewImage | 多视图；`left`/`right`/`back`（3.1 加 `top`/`bottom`/`left_front`/`right_front`）；每视角 1 张；全部图片 base64 总和 ≤6MB；jpg/png |
| `EnablePBR` | 否 | Boolean | PBR 材质（金属度/粗糙度/法线），默认 false |
| `FaceCount` | 否 | Integer | 面数，3000–1500000，默认 500000 |
| `GenerateType` | 否 | String | `Normal`（默认，带纹理几何）/ `LowPoly`（智能减面，FaceCount 失效）/ `Geometry`（白模，EnablePBR 失效）/ `Sketch`（草图，prompt 与图可同传） |
| `PolygonType` | 否 | String | 仅 LowPoly：`triangle`（默认）/ `quadrilateral` |
| `ResultFormat` | 否 | String | 仅限一种；默认返回 obj、glb 文件组；可选 STL/USDZ/FBX（国内 SDK 注释）；Geometry 模式默认 glb |

响应：

```json
{ "Response": { "JobId": "1422504058612350976", "RequestId": "c942d2da-..." } }
```

（`JobId` 有效期 24 小时）

#### 2.2.2 查询混元生3D专业版任务 `QueryHunyuanTo3DProJob`

- 国内文档：[查询混元生3D专业版任务（1804/123448）](https://cloud.tencent.com/document/product/1804/123448)；国际版：[75541](https://www.tencentcloud.com/zh/document/product/1284/75541)
- 请求：`{ "JobId": "..." }`

响应：

| 字段 | 说明 |
|---|---|
| `Status` | `WAIT`（等待）/ `RUN`（执行）/ `FAIL`（失败）/ `DONE`（成功） |
| `ErrorCode` / `ErrorMessage` | 失败原因（如 `InvalidParameter` 参数错误） |
| `ResultFile3Ds` | `Array of File3D`：`Type`（OBJ/GLB/FBX 等）、`Url`（COS 签名 URL，有效期 24 小时/1 天）、`PreviewImageUrl`（预览图） |
| `ResultCreditDetails` | 计费明细字符串，如 `{"GenerateType-Normal":20, "Pbr":10, "FaceCount":10}` |
| `ResultCreditConsumed` | 本任务总消耗积分（示例 40） |

#### 2.2.3 极速版 `SubmitHunyuanTo3DRapidJob` / `QueryHunyuanTo3DRapidJob`

- 国内：[提交 123463](https://cloud.tencent.com/document/product/1804/123463) / [查询 123464](https://cloud.tencent.com/document/product/1804/123464)；国际：[提交 75976](https://intl.cloud.tencent.com/zh/document/product/1284/75976)
- 默认并发 **1**；目标耗时 1 分 30 秒内
- 请求字段：`Prompt`（≤200 字符）/ `ImageBase64` / `ImageUrl`（三选一，约束同专业版）+ `ResultFormat`（OBJ/GLB/STL/USDZ/FBX/MP4）+ `EnablePBR` + `EnableGeometry`（白模；开启时默认输出 GLB）
- 查询响应结构同专业版（无 `ResultCreditDetails`/`ResultCreditConsumed`）

#### 2.2.4 基础版 `SubmitHunyuanTo3DJob` / `QueryHunyuanTo3DJob`（注意）

- 存在于产品更新历史（2025-07-07 第 1 次发布新增，[1804/120839](https://cloud.tencent.com/document/product/1804/120839)）与 2025-07 SDK（javadoc 快照确认 Request/Response 类存在）
- **最新版官方 Go/Node SDK 已移除该接口**，公开 API 文档页未检索到（CloudBase MCP 模板仍以 `submitHunyuanTo3DJob` 名称暴露，核心参数 `Prompt`/`ImageBase64`/`ImageUrl` 三选一）
- 结论：**新工程不要依赖基础版**，统一走专业版/极速版或 TokenHub

#### 2.2.5 其他生成类接口（组件/人物）

| 接口 | 文档 | 说明 |
|---|---|---|
| `SubmitHunyuan3DPartJob` / `QueryHunyuan3DPartJob` | [1804/126295](https://cloud.tencent.com/document/product/1804/126295)（国际 API 概览亦列） | 组件生成：输入 FBX，自动识别结构拆分组件；`Model` 默认 1.5；`EnableStagedGeneration` 分步（带 `PartSegmentationInfo`/`PartSegmentationInfoUrl`）；`EnablePostProcess` +20 积分 |
| `SubmitProfileTo3DJob` / `DescribeProfileTo3DJob` | [1804/127685](https://cloud.tencent.com/document/product/1804/127685) | 3D 人物生成：真人头像（`Profile` Base64/Url，分辨率 500–4096，≤10MB）+ 模板（`Template`：basketball/badminton/pingpong/guitar/explorer 等 20 个）生成人物模型；30 积分/次 |

---

## 3. 后处理类接口（绑骨 / 动作 / 拓扑 / UV / 纹理 / 格式转换）

> 全部为「提交 + 查询」异步任务对，统一模式：提交返回 `JobId`（24h 有效）→ 轮询查询 → `Status`（WAIT/RUN/FAIL/DONE）+ `ResultFile3Ds`。
> 完整接口清单官方来源：[操作审计-腾讯混元大模型（629/97728）](https://cloud.tencent.com/document/product/629/97728)（2026-07-28 更新）、[访问管理接口列表（598/97722）](https://cloud.tencent.com/document/product/598/97722)。

### 3.1 自动绑骨蒙皮（auto rigging）—— 官方有

`SubmitAutoRiggingJob` / `DescribeAutoRiggingJob`

- 国内文档：[提交 131618](https://cloud.tencent.com/document/product/1804/131618) / [查询 131619](https://cloud.tencent.com/document/product/1804/131619)（域名 `ai3d.tencentcloudapi.com`，Version `2025-05-13`）
- 国际文档：[提交 79641](https://intl.cloud.tencent.com/zh/document/product/1284/79641) / [查询 79642](https://www.tencentcloud.com/zh/document/product/1284/79642)（域名 `hunyuan.intl.tencentcloudapi.com`，Version `2023-09-01`）
- 默认并发 1；频率限制 20 次/秒

请求参数：

| 参数 | 必选 | 说明 |
|---|---|---|
| `File3D` | 是 | `InputFile3D{Url, Type}`；FBX 或 GLB，≤60MB。**输入要求：人形需标准姿态（A Pose 或 T Pose）**、尽量无动作、不含武器/坐骑/翅膀等外挂件、避免松散衣物配饰复杂发型；非人形限二足/四足/鸟类等单一生命体且不支持动作模板 |
| `MotionType` | 否 | 预设动作类型（Integer 1–48），绑骨时可直接指定一个动作，详见 §3.2 动作目录 |

响应：`JobId`。查询结果：`ResultFile3Ds`（`Type: FBX`，带骨骼信息的 FBX 文件）。**10 积分/次**。

### 3.2 动作目录与文生动作 —— 官方有

**（a）绑骨接口内置 48 个预设动作**（`SubmitAutoRiggingJob.MotionType`，来自 [131618](https://cloud.tencent.com/document/product/1804/131618) 完整枚举）：

| 编号 | 动作 | 编号 | 动作 | 编号 | 动作 | 编号 | 动作 |
|---|---|---|---|---|---|---|---|
| 1 | 回旋踢 | 13 | 落地 | 25 | 走路-3 | 37 | 冲刺跑-3 |
| 2 | 左勾拳 | 14 | 沮丧 | 26 | 待机-1 | 38 | 原地跳-1 |
| 3 | 蓄力攻击 | 15 | 割喉 | 27 | 待机-2 | 39 | 滑铲 |
| 4 | 蓄力出拳 | 16 | 刺拳 | 28 | 街舞 | 40 | 向前大跳 |
| 5 | 二连击打 | 17 | 连续击打 | 29 | 扭扭舞 | 41 | 向前大跳-2 |
| 6 | 二连击打-2 | 18 | 踢腿 | 30 | 左转弯 | 42 | 跨越 |
| 7 | 后撤 | 19 | 侧踢 | 31 | 右转弯 | 43 | 恐吓 |
| 8 | 受击 | 20 | 打太极 | 32 | 慢跑 | 44 | 向前跌倒 |
| 9 | 受击-2 | 21 | 后空翻 | 33 | 慢跑-2 | 45 | 右转 |
| 10 | 受击-3 | 22 | 蹲姿转体 | 34 | 奔跑 | 46 | 原地跳-2 |
| 11 | 受击倒地-1 | 23 | 走路-1 | 35 | 冲刺跑-1 | 47 | 转身 |
| 12 | 受击倒地-2 | 24 | 走路-2 | 36 | 冲刺跑-2 | 48 | 发送冲击波 |

> 这批预设动作可作本包 `meshy-actions.ts`（约 680 条静态动作目录）的**官方替代子集**；其余动作仍需本地保留（离线 mock 用途）。

**（b）文生动作 `SubmitHunyuanTo3DMotionJob` / `DescribeHunyuanTo3DMotionJob`**（国内版独有）

- 文档：[提交 131256](https://cloud.tencent.com/document/product/1804/131256) / [查询 131257](https://cloud.tencent.com/document/product/1804/131257)；域名 `ai3d.tencentcloudapi.com`，Version `2025-05-13`
- 输入文本 → 生成 3D 人物动作数据 → 输出**带动画数据的 FBX**。默认并发 1

请求参数：

| 参数 | 必选 | 说明 |
|---|---|---|
| `Prompt` | 是 | 动作文本描述，≤128 字符（如 "A person walks forward"） |
| `Model` | 否 | `HY-Motion-1.0`（默认） |
| `RetargetFile` | 否 | `InputFile3D`；需重定向的模型地址（仅支持混元生3D动画生成的模型） |
| `Duration` | 否 | 动画时长 1–12 秒，默认 5 |
| `EnableMesh` | 否 | 默认 true：返回的 FBX 是否带蒙皮 mesh |
| `EnableRewrite` | 否 | 默认 false：prompt 扩写 |
| `EnableDurationEst` | 否 | 默认 false：时长自动匹配 |

响应：`JobId`；查询返回 `ResultFile3Ds`（FBX）。**10 积分/次**。

### 3.3 人物模型3D动画 `SubmitCharacterToAnimationJob` / `DescribeCharacterToAnimationJob` —— 存在但公开文档缺失

- 官方在以下两处列出该接口（确认存在）：
  - 操作审计（[629/97728](https://cloud.tencent.com/document/product/629/97728)，2026-07-28 更新）：「提交人物模型3D动画生成任务」「查询人物模型3D动画任务」
  - 访问管理（[598/97722](https://cloud.tencent.com/document/product/598/97722)，2026-07-06 更新）：`SubmitCharacterToAnimationJob` 提交人物模型3D动画生成任务
- **未检索到公开 API 文档页**（请求/响应字段未知），国际版 API 概览（1284/75531）亦未列出
- 建议：以 API Explorer / 控制台实测确认字段后再接入；不确定时优先用「绑骨+预设动作」或「文生动作」组合替代

### 3.4 低模重拓扑 —— 官方有（智能拓扑 + 减面）

**（a）智能拓扑 `Submit3DSmartTopologyJob` / `Describe3DSmartTopologyJob`**

- 国内文档：[提交 126293](https://cloud.tencent.com/document/product/1804/126293) / [查询 126298](https://cloud.tencent.com/document/product/1804/126298)；域名 `ai3d.tencentcloudapi.com`
- 国际文档：[77048](https://www.tencentcloud.com/zh/document/product/1284/77048)（`hunyuan.intl.tencentcloudapi.com`）
- 采用 Polygon 1.5 模型：输入 3D 高模 → 布线规整、较低面数模型。默认并发 1

请求参数：

| 参数 | 必选 | 说明 |
|---|---|---|
| `File3D` | 是 | `InputFile3D`；Type：glb/obj；Url 文件 ≤200MB；**建议输入未拓扑过的高模**（如混元3D 生成模型）；硬表面/游戏角色/道具/日用品适用度高 |
| `PolygonType` | 否 | `triangle`（默认）/ `quadrilateral` |
| `FaceLevel` | 否 | 减面后档位：`high` / `medium` / `low` |

响应：`JobId`；查询返回 `ResultFile3Ds`（OBJ 模型 + IMAGE 预览图）。**50 积分/次**。

**（b）减面 `SubmitReduceFaceJob` / `DescribeReduceFaceJob`**（ai3d SDK 独有，公开文档页未检索到）

- 来自官方 Go SDK（[ai3d v20250513 models.go](https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/ai3d/v20250513/models.go)）：`File3D`（Type：OBJ/GLB）+ `PolygonType`（triangle/quadrilateral）+ `FaceLevel`（high/medium/low）

**（c）生成时直接 LowPoly**：专业版 `GenerateType=LowPoly`（25 积分/次，见 §2.2.1）

### 3.5 UV 展开 `SubmitHunyuanTo3DUVJob` / `DescribeHunyuanTo3DUVJob`

- 来源：[操作审计](https://cloud.tencent.com/document/product/629/97728) + [Go SDK](https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/ai3d/v20250513/models.go)
- 请求：`File`（`InputFile3D`，支持 FBX/OBJ/GLB）；查询输出 `ResultFile3Ds`
- **10 积分/次**

### 3.6 纹理生成/纹理编辑

- 纹理生成 `SubmitTextureTo3DJob` / `DescribeTextureTo3DJob`（ai3d SDK 独有，公开文档页未检索到；输入单几何模型 + 参考图/文字 → 纹理贴图；**30 积分/次**，来自计费文档）
- 纹理编辑 `SubmitHunyuanTo3DTextureEditJob` / `QueryHunyuanTo3DTextureEditJob`（国际 API 概览列出；**30 积分/次**）

### 3.7 3D 文件格式转换 —— 官方有

- 异步：`SubmitConvert3DFormatJob` / `DescribeConvert3DFormatJob`，国际文档：[提交 78768](https://intl.cloud.tencent.com/zh/document/product/1284/78768) / [查询 78769](https://www.tencentcloud.com/zh/document/product/1284/78769)
- 同步：`Convert3DFormat`（**一次请求直接返回 `ResultFile3D` URL，无需轮询**；请求 `File3D`（URL，≤60MB，支持 fbx/obj/glb）+ `Format`（STL/USDZ/FBX/MP4/GIF）；来自 [Go SDK](https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/ai3d/v20250513/models.go)）
- **5 积分/次**

---

## 4. 能力覆盖对照（目标能力面 → 官方）

| 原插件能力 | 官方 Hunyuan3D 支持 | 说明 |
|---|---|---|
| 文生3D | ✅ | TokenHub `prompt` / `SubmitHunyuanTo3DProJob.Prompt` / 极速版 |
| 图生3D | ✅ | `image_base64`/`image_url` / `ImageBase64`/`ImageUrl` |
| 多视图生3D | ✅ | `MultiViewImages`（3 视角；3.1 八视角）+10 积分 |
| Meshy 两阶段精修 | ⚠️ 无直接对应 | 官方无 refine 接口；可用纹理生成/编辑替代（语义不同，见 §3.6） |
| 自动绑骨 | ✅ | `SubmitAutoRiggingJob`（10 积分/次） |
| 套动作 | ✅ | `MotionType` 48 预设（绑骨时）；文生动作 `SubmitHunyuanTo3DMotionJob` |
| 动作目录 | ✅（48 条官方）/ 保留本地 | 官方 48 条可作 `meshy-actions.ts` 的官方子集，680 条完整目录仍需本地保留（mock/展示） |
| 低模重拓扑 | ✅ | `Submit3DSmartTopologyJob`（50 积分/次）、`SubmitReduceFaceJob`、`GenerateType=LowPoly` |
| 质量评分 | ❌ 官方无 | 保留本地 quality/ 启发式评分 |
| GLB 动作合并导出可玩角色 | ❌ 官方无 | 保留本地 gltf-transform 合并（`merge-playable-character`）；官方 `Convert3DFormat` 只做格式转换 |
| 姿态标准化 | ⚠️ 无独立 API | 绑骨要求输入 A/T Pose（输入约束）；近似：`SubmitProfileTo3DJob` 真人头像+模板人物 |
| 文件上传/下载 | ⚠️ 需自备 | 官方接口收「公网 URL」（Url 参数），COS 签名 URL 由官方返回；插件需提供文件直链（如本地上传至用户 COS 或临时直链） |

---

## 5. 价格 / 配额 / 错误码

### 5.1 计费（积分制）

来源：[腾讯混元生3D 计费概述（1804/123461，2026-07-24 更新）](https://cloud.tencent.com/document/product/1804/123461)

- **免费额度**：首次开通后控制台手动领取一次性免费积分包 **100 积分**（1 年有效）
- **预付费积分包**（1 年有效，支持 7 天内未使用退款，仅抵扣购买后用量）：

| 积分数 | 价格 | 单价 |
|---|---|---|
| 1,000 | 100 元 | 0.100 元/积分 |
| 10,000 | 980 元 | 0.098 元/积分 |
| 50,000 | 4,750 元 | 0.095 元/积分 |
| 100,000 | 9,000 元 | 0.090 元/积分 |

- **后付费**：0.12 元/积分，**日结**（默认不自动开通，需控制台开启；免费/预付费耗尽后不自动转后付费）
- 结算顺序：免费资源包 → 预付费资源包 → 后付费。**任务失败（任何原因，含内容风控）不扣积分**

**单次任务消耗积分**（专业版生成类型 + 附加参数叠加）：

| 项目 | 积分 |
|---|---|
| 专业版 Normal（默认文/图生3D 带贴图） | 20 |
| 专业版 LowPoly | 25 |
| 专业版 Geometry（白模） | 15 |
| 专业版 Sketch（草图） | 25 |
| 极速版（Prompt 或 ImageUrl/ImageBase64） | 15 |
| 附加：MultiViewImages | +10 |
| 附加：EnablePBR | +10 |
| 附加：FaceCount | +10 |
| 附加：ResultFormat | +5 |
| 后处理：智能拓扑 | 50 |
| 后处理：纹理生成 / 纹理编辑 | 30 |
| 后处理：3D 人物生成 | 30 |
| 后处理：组件生成（后处理开启另 +20） | 30 |
| 后处理：UV 展开 | 10 |
| 后处理：文生动作 | 10 |
| 后处理：绑骨蒙皮 | 10 |
| 后处理：模型格式转换 | 5 |

**并发与频率**：

- 专业版默认 **3 并发**；极速版、智能拓扑、纹理、人物、组件、UV、文生动作、格式转换默认 **1 并发**（主子账号共享）
- 并发叠加包：**30,000 元/并发/月**
- 接口请求频率限制：**20 次/秒**（查询接口同样 20 次/秒）

### 5.2 错误码

- 各接口文档「错误码」章节均标注：**暂无业务逻辑相关的错误码，其他错误码详见公共错误码**
- 任务级错误：异步查询响应的 `ErrorCode` / `ErrorMessage`（示例值 `InvalidParameter`「参数错误」、`FailedOperation.InnerError`「服务内部错误，请重试」）
- 请求级错误：腾讯云 API 3.0 标准错误结构 `Response.Error{Code, Message}` + `RequestId`；常见类别：`AuthFailure.*`（签名/密钥类）、`InvalidParameter.*`、`FailedOperation.*`、`ResourceUnavailable.*`（含计费/配额异常，对应计费文档「免费包耗尽且未开通后付费将出现计费异常报错」）、`LimitExceeded.*`（频率/并发超限）
- TokenHub 路径错误形态为 OpenAI 风格（HTTP 状态码 + error 字段），具体错误码官方文档未展开，以实际响应为准

### 5.3 平台迁移风险（重要）

计费概述顶部官方公告（[1804/123461](https://cloud.tencent.com/document/product/1804/123461)）：

> 「腾讯混元大模型相关功能将逐步迁移至 TokenHub。迁移后，原平台将不再新增模型能力，并停止支持新购模型服务。用户已购买的模型服务可继续使用，暂不受影响。如需开通新的模型服务或使用更多模型能力，请前往 TokenHub。」

→ **新工程开户/购量应走 TokenHub**；腾讯云 API 3.0（ai3d/hunyuan 网关）适合已有存量额度或需要后处理接口的场景。

---

## 6. 调用示例

### 6.1 TokenHub 路径（curl）

```bash
# 1) 提交文生3D 任务
curl --location 'https://tokenhub.tencentmaas.com/v1/api/3d/submit' \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "hy-3d-3.0",
    "prompt": "一只小狗"
  }'
# => {"id":"14*******984","request_id":"75********33","object":"3d_job","created_at":1774806931,"status":"queued"}

# 2) 轮询查询（间隔 2~3s，直到 status=completed）
curl --location 'https://tokenhub.tencentmaas.com/v1/api/3d/query' \
  --header 'Authorization: Bearer YOUR_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "hy-3d-3.0",
    "id": "14*******984"
  }'
# 进行中: {"request_id":"...","object":"3d_job","created_at":...,"status":"in_progress"}
# 完成:   {"status":"completed","data":[
#           {"type":"obj","url":"https://...","preview_image_url":"https://..."},
#           {"type":"glb","url":"https://...","preview_image_url":"https://..."}]}
```

（来源：[TokenHub 3D 生成文档](https://cloud.tencent.com/document/product/1823/130082)）

### 6.2 腾讯云 API 3.0 路径（Node.js SDK，推荐）

```bash
npm install tencentcloud-sdk-nodejs
```

```js
const tencentcloud = require('tencentcloud-sdk-nodejs');
const Ai3d = tencentcloud.ai3d.v20250513;

const client = new Ai3d.Client({
  credential: { secretId: process.env.TENCENTCLOUD_SECRET_ID,
                secretKey: process.env.TENCENTCLOUD_SECRET_KEY },
  region: process.env.TENCENTCLOUD_REGION || 'ap-guangzhou',
  profile: { httpProfile: { endpoint: 'ai3d.tencentcloudapi.com' } },
});

// 提交文生3D（专业版）
const { JobId } = await client.SubmitHunyuanTo3DProJob({
  Model: '3.1',
  Prompt: '一只穿盔甲的卡通狼人，游戏角色，PBR 材质',
  EnablePBR: true,
  GenerateType: 'Normal',
});
console.log('JobId =', JobId);

// 轮询查询
for (;;) {
  const r = await client.QueryHunyuanTo3DProJob({ JobId });
  if (r.Status === 'DONE') {
    console.log(r.ResultFile3Ds, r.ResultCreditConsumed); // [{Type,Url,PreviewImageUrl}]
    break;
  }
  if (r.Status === 'FAIL') throw new Error(`${r.ErrorCode}: ${r.ErrorMessage}`);
  await new Promise((res) => setTimeout(res, 3000));
}
```

（SDK 安装与初始化方式参见腾讯云 [Node.js SDK 文档](https://cloud.tencent.com/document/sdk/Node.js)；接口字段见 §2/§3）

### 6.3 腾讯云 API 3.0 路径（原生 HTTP + TC3 签名要点）

若不用 SDK，需实现 TC3-HMAC-SHA256 签名（完整算法见[官方签名文档](https://cloud.tencent.com/document/product/1278/8530)），要点：

1. POST 到 `https://ai3d.tencentcloudapi.com/`，`Content-Type: application/json`，body 为业务参数 JSON
2. 头：`X-TC-Action`（如 `SubmitHunyuanTo3DProJob`）、`X-TC-Version`（`2025-05-13`）、`X-TC-Region`（如 `ap-guangzhou`）、`X-TC-Timestamp`、`X-TC-Signature-Version`（`TC3-HMAC-SHA256`）、`Authorization`
3. `Authorization` 由 `TC3-HMAC-SHA256 Credential=<SecretId>/<date>/ai3d/tc3_request, SignedHeaders=content-type;host, Signature=<sig>` 组成；sig 依次派生 `TC3-HMAC-SHA256` 密钥 → 签名 → `tc3_request` 摘要
4. 示例请求头（官方文档格式，字段见 [提交绑骨蒙皮任务](https://cloud.tencent.com/document/product/1804/131618) 示例）：

```
POST / HTTP/1.1
Host: ai3d.tencentcloudapi.com
Content-Type: application/json
X-TC-Action: SubmitAutoRiggingJob
X-TC-Version: 2025-05-13
X-TC-Region: ap-guangzhou
<公共请求参数 + Authorization>

{"File3D":{"Url":"https://***.cos.ap-guangzhou.myqcloud.com/3d/xxx.fbx","Type":"FBX"},"MotionType":1}
```

### 6.4 后处理调用示例（Node SDK，绑骨 + 文生动作）

```js
// 绑骨（输入 T/A Pose 模型，可选预设动作）
const rig = await client.SubmitAutoRiggingJob({
  File3D: { Url: 'https://your-host/character.fbx', Type: 'FBX' },
  MotionType: 23, // 走路-1
});
// 轮询 DescribeAutoRiggingJob({ JobId: rig.JobId }) → ResultFile3Ds[0].Url（FBX 带骨骼）

// 文生动作
const motion = await client.SubmitHunyuanTo3DMotionJob({
  Prompt: 'A person walks forward',
  Model: 'HY-Motion-1.0',
  Duration: 5,
  EnableMesh: true,
});
// 轮询 DescribeHunyuanTo3DMotionJob({ JobId: motion.JobId }) → ResultFile3Ds[0].Url（FBX 动画）
```

> 注意：腾讯云 API 3.0 各「输入文件」参数（`File3D`/`File`/`ImageUrl`/`Profile.Url`）接受的是**公网可访问的 URL**（官方示例均使用 COS 链接），插件侧需要把本地文件转成可公网访问的直链（用户 COS / 临时静态托管）后再提交。

---

## 7. 来源 URL 清单

**产品与平台**
- 产品页（混元生3D）：https://cloud.tencent.com/product/ai3d
- 产品文档首页（腾讯混元生3D，含购买指南）：https://cloud.tencent.com/document/product/1804
- 产品更新历史：https://cloud.tencent.com/document/product/1804/120839
- TokenHub 3D 生成：https://cloud.tencent.com/document/product/1823/130082
- TokenHub 混元调用指南（API Key）：https://cloud.tencent.com/document/product/1823/132252
- 计费概述：https://cloud.tencent.com/document/product/1804/123461
- 操作审计接口清单：https://cloud.tencent.com/document/product/629/97728
- 访问管理接口清单：https://cloud.tencent.com/document/product/598/97722
- CloudBase 腾讯混元3D MCP（环境变量/工具清单佐证）：https://docs.cloudbase.net/ai/mcp/develop/server-templates/cloudrun-mcp-hunyuan-3d

**接口文档（国内 ai3d，Version 2025-05-13）**
- 提交混元生3D专业版任务：https://cloud.tencent.com/document/product/1804/123447
- 查询混元生3D专业版任务：https://cloud.tencent.com/document/product/1804/123448
- 提交混元生3D极速版任务：https://cloud.tencent.com/document/product/1804/123463
- 查询混元生3D极速版任务：https://cloud.tencent.com/document/product/1804/123464
- 提交绑骨蒙皮任务：https://cloud.tencent.com/document/product/1804/131618
- 查询绑骨蒙皮任务：https://cloud.tencent.com/document/product/1804/131619
- 提交文生动作任务：https://cloud.tencent.com/document/product/1804/131256
- 查询文生动作任务：https://cloud.tencent.com/document/product/1804/131257
- 提交智能拓扑任务：https://cloud.tencent.com/document/product/1804/126293
- 查询智能拓扑任务：https://cloud.tencent.com/document/product/1804/126298
- 提交3D人物生成任务：https://cloud.tencent.com/document/product/1804/127685
- 提交组件生成任务：https://cloud.tencent.com/document/product/1804/126295

**接口文档（国际 hunyuan，Version 2023-09-01）**
- API 概览（完整接口清单）：https://www.tencentcloud.com/zh/document/product/1284/75531
- 提交混元生3D专业版任务：https://www.tencentcloud.com/zh/document/product/1284/75540
- 查询混元生3D专业版任务：https://www.tencentcloud.com/zh/document/product/1284/75541
- 提交混元生3D极速版任务：https://intl.cloud.tencent.com/zh/document/product/1284/75976
- 提交绑骨蒙皮任务：https://intl.cloud.tencent.com/zh/document/product/1284/79641
- 查询绑骨蒙皮任务：https://www.tencentcloud.com/zh/document/product/1284/79642
- 提交智能拓扑任务：https://www.tencentcloud.com/zh/document/product/1284/77048
- 提交3D文件格式转换任务：https://intl.cloud.tencent.com/zh/document/product/1284/78768
- 查询3D文件格式转换任务：https://www.tencentcloud.com/zh/document/product/1284/78769

**签名 / SDK / 佐证**
- TC3-HMAC-SHA256 签名方法 v3：https://cloud.tencent.com/document/product/1278/8530
- 腾讯云 Node.js SDK 文档：https://cloud.tencent.com/document/sdk/Node.js
- 官方 Go SDK ai3d v20250513 模型定义（基础版已移除、减面/UV/纹理/同步格式转换等字段佐证）：https://github.com/TencentCloud/tencentcloud-sdk-go/blob/master/tencentcloud/ai3d/v20250513/models.go
- 官方 Java SDK ai3d v20250513 类清单（含 SubmitHunyuanTo3DJob/QueryHunyuanTo3DJob/ViewImage）：https://javadoc.io/static/com.tencentcloudapi/tencentcloud-sdk-java/3.1.1309/com/tencentcloudapi/ai3d/v20250513/models/package-summary.html
- 社区实践（轮询间隔佐证）：https://cloud.tencent.com/developer/article/2722154

---

## 8. 已知缺口与风险（如实标注）

1. **基础版 `SubmitHunyuanTo3DJob` 已淡出**：最新官方 SDK 已移除，公开 API 文档页未检索到；勿作为新工程依赖。
2. **`SubmitCharacterToAnimationJob`（人物模型3D动画）公开文档缺失**：仅操作审计/访问管理确认接口存在，字段未知；接入前需 API Explorer 实测。
3. **TokenHub 仅覆盖生成类**：绑骨/文生动作/智能拓扑/UV/纹理/格式转换等后处理未见 TokenHub 公开文档，需走腾讯云 API 3.0（TC3 签名）。
4. **官方无质量评分、无 GLB 动作合并导出、无 Meshy 式两阶段精修**：分别保留本地启发式评分、gltf-transform 合并、以纹理生成/编辑近似替代。
5. **输入文件需公网 URL**：官方所有 `File3D`/`ImageUrl` 参数要求可公网访问的直链，插件需自备文件托管（如用户 COS）。
6. **平台迁移**：官方公告混元能力将逐步迁至 TokenHub、原平台停新购；本文档两路径均已给出，落地时建议 TokenHub 优先。
7. **价格可能变动**：积分单价/消耗为 2026-07-24 文档快照；购买前以控制台购买页为准。
