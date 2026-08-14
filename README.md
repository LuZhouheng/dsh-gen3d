# dsh-gen3d

DeepSeek Harness（DSH）的 **3D 角色生成插件**：把一句需求 / 一张参考图变成带贴图、游戏可用的 3D 角色资产。直连 **Meshy / 腾讯混元 3D / Tripo3D / Rodin（Hyper3D）四家官方 API**，凭证由用户自行配置，插件不内置任何 key；未配置 key 时自动回退**确定性 mock**（能跑通全链路，但不产生真实模型、不消耗配额）。

## 安装

**推荐从 npm registry 安装**（已发布、自带构建产物，唯一推荐方式）：

```bash
dsh plugin --profile web add dsh-gen3d
```

> **git 安装（不推荐，仅备用）**：`dsh plugin --profile web add github:LuZhouheng/dsh-gen3d`。
> git 安装拉的是源码（`lib/` 不进 Git），包内已备自包含 `prepare` 脚本
> （`tsc -p tsconfig.build.json`，跨平台、无 shell 依赖）在安装时自动构建；
> 但 pnpm ≥10 默认拦截 git 依赖的构建脚本，还需按 DSH publish 文档在该 profile
> 的 `pnpm-workspace.yaml` 中为 `dsh-gen3d` 声明 `allowBuilds` 构建许可后才生效。
> 第三方插件目录站自动生成的 `github:` 安装命令即此路径——照抄前请知悉。

## 凭证配置

> 本插件**不含任何 API key**。所有真实生成调用都使用你自己购买并配置的官方 key；未配置时回退 mock，不会偷偷调用任何第三方服务。

插件直连四家官方 API，各配各的 key（变量名与 `src/config.ts` 注册表一致，详见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)）：

| 供应商 | 凭证变量名 | 获取入口 | 备注 |
| --- | --- | --- | --- |
| Meshy | `MESHY_API_KEY` | [platform.meshy.ai](https://platform.meshy.ai) 登录后 **Settings → API（API settings 页）** Create API Key | 注册即可建 key；key 只显示一次，可随时吊销 |
| 腾讯混元 3D（生成） | `HUNYUAN3D_API_KEY` | **TokenHub 控制台**创建 API Key（[混元调用指南](https://cloud.tencent.com/document/product/1823/132252)） | 官方主推路径，Bearer 直用；首次开通送 100 免费积分 |
| 腾讯混元 3D（后处理） | `HUNYUAN3D_SECRET_ID` + `HUNYUAN3D_SECRET_KEY` | 腾讯云控制台 **访问管理 → API 密钥管理**（CAM） | 可选；TC3 签名路径（腾讯云 API 3.0），**绑骨 / 文生动作 / 智能拓扑等后处理能力必需** |
| Tripo3D | `TRIPO3D_API_KEY` | [platform.tripo3d.ai/api-keys](https://platform.tripo3d.ai/api-keys) 生成 | key 以 `tsk_` 开头；`tcli_` 开头的 Client ID 仅标识应用，**不能用于认证** |
| Rodin（Hyper3D） | `RODIN_API_KEY` | [hyper3d.ai](https://hyper3d.ai) 登录后 **API Key Management** 页面 "+Create new API Keys" | 需 **Business 订阅（$120/月）** 才有 API access；key 只显示一次，可吊销 |

### 配置方式

推荐写入 `$DSH_HOME/.credentials.yaml`（`$DSH_HOME` 未设置时默认 `~/.dsh`）。解析器兼容两种写法，**根映射**为权威 DSH 形态（文档仅一个扁平映射），**`credentials:` 包裹层**为兼容形态（README 旧示例），二者等价：

```yaml
# 形态一（权威）：根映射
MESHY_API_KEY: "meshy-xxxxxxxx"
HUNYUAN3D_API_KEY: "xxxxxxxx"
TRIPO3D_API_KEY: "tsk_xxxxxxxx"
RODIN_API_KEY: "xxxxxxxx"
HUNYUAN3D_SECRET_ID: "AKIDxxxxxxxx"   # 可选：腾讯云后处理（TC3 签名）
HUNYUAN3D_SECRET_KEY: "xxxxxxxx"      # 可选：腾讯云后处理（TC3 签名）
```

```yaml
# 形态二（兼容）：顶层 credentials: 包裹一层，与根映射等价
credentials:
  MESHY_API_KEY: "meshy-xxxxxxxx"
```

或通过环境变量注入（**优先级最高**，遮蔽同名文件配置；也可用 `<cwd>/.env`、`$DSH_HOME/.env`）：

```bash
export MESHY_API_KEY="meshy-xxxxxxxx"
export HUNYUAN3D_API_KEY="xxxxxxxx"
```

读取优先级（与 DSH credentials-local 四层一致）：**环境变量 > `$DSH_HOME/.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`**；空字符串视为未配置；每次调用实时重读文件，key 轮换**无需重启**。完整安全指引（掩码规则、key 不进仓库、文件权限）见 [docs/CREDENTIALS.md](docs/CREDENTIALS.md)。

配好后用 `gen3d:provider-status` 验证（只显示是否配置与脱敏尾缀，不打印完整 key）。

## 功能

19 个 DSH 工具（`src/tools/`，`allGen3dTools`），分四组：

**生成（11 个）**

| 工具 | 说明 |
| --- | --- |
| `gen3d_provider_status` | 供应商状态：四家 key 配置状态 / 模型 / 能力说明，零调用 |
| `gen3d_credentials_status` | 凭证状态：只读掩码查询各家 key 是否配置（前 4 后 4，绝不输出完整密钥） |
| `gen3d_list_assets` | 资产盘点：工作区 3D 资产清单 + 完整 sidecar 元数据 |
| `gen3d_delete_asset` | 删除资产：主 GLB + sidecar + 侧文件，缓存键打 tombstone（破坏性操作） |
| `gen3d_text_to_3d` | 文生 3D：一句需求生成带贴图角色（默认 Meshy，可切三家） |
| `gen3d_image_to_3d` | 图生 3D：一张参考图生成模型（URL / base64 / 本地文件三形态） |
| `gen3d_views_to_3d` | 多视图生 3D：多角度参考图生成（front 必填） |
| `gen3d_refine_mesh` | 精修：Meshy 两阶段精修（可追加贴图） |
| `gen3d_retopo_lowpoly` | 低模重拓扑：从高模源产出规整低面数新资产（源资产保留） |
| `gen3d_rename_asset` | 重命名：设置显示名（userLabel），不动磁盘 / 缓存键 |
| `gen3d_score_quality` | 质量评分：客观五维（geometry / topology / texture / pbr / prompt_fidelity），不调用 provider |

**动画（3 个）**

| 工具 | 说明 |
| --- | --- |
| `gen3d_auto_rig` | 自动绑骨：人形资产追加骨架（保贴图，Meshy 自带免费 walk/run 片段） |
| `gen3d_apply_motion` | 套动作：一次一个、按动作幂等追加动画 |
| `gen3d_list_motions` | 动作目录：Meshy 约 690 条 / Hunyuan 48 预设 / Tripo 16 个 `preset:*` |

**可玩角色（5 个）**

| 工具 | 说明 |
| --- | --- |
| `gen3d_get_playable_profile` | 读取动作档：内置 preset 锚 + 角色覆盖 + 映射草稿 + 交付快照 |
| `gen3d_set_playable_profile` | 设置动作档：写角色动作槽覆盖（DSH 无游戏级默认档） |
| `gen3d_set_playable_motion_mapping` | 动作映射：槽位 ↔ 已套动作绑定（导出前置条件） |
| `gen3d_export_playable_character` | 导出可玩角色：动作合并输出 `merged.glb` + `playable.json` |
| `gen3d_adopt_playable_character` | 采纳交付物：孤儿 `merged.glb` 补 clip 映射与交付快照 |

一句话产线：**生成 → 评分 → 命名 →（要会动才）绑骨 → 套动作 → 导出**；静态优先、会动 opt-in（按次计费）。注：legacy 的 `pose-standardization`（A/T-pose 标准化）**暂缓未迁移**——官方无独立等价 API，详见[已知缺口](#已知缺口)。

### 供应商能力矩阵

四家官方 API 能力对照（依据 `docs/providers/` 四份协议文档，2026-08-13 官方文档快照；✅ 官方支持 / ⚠️ 部分或近似 / ❌ 无）：

| 能力 | Meshy | 腾讯混元 3D | Tripo3D | Rodin |
| --- | --- | --- | --- | --- |
| 文生 3D | ✅ text-to-3d v2（两阶段 preview→refine） | ✅ TokenHub `hy-3d-3.0/3.1`，或 TC3 专业版 | ✅ `text_to_model`（H3/H2/P1 三产品线） | ✅ `/api/v2/rodin`（不传 images） |
| 图生 3D | ✅ image-to-3d（URL / base64） | ✅ `image_base64` / `image_url` | ✅ `image_to_model`（file_token / URL / STS object，**不支持 base64**） | ✅ `/api/v2/rodin`（1 张 images） |
| 多视图生 3D | ✅ multi-image-to-3d（1–4 张） | ✅ 3 视角（3.1 版 8 视角） | ✅ `multiview_to_model`（固定 4 视角 `front,left,back,right`，front 必填） | ✅ 2–5 张（form 保序，**首张固定用于材质生成**） |
| 自动绑骨 | ✅ rigging（人形带贴图，自带 walk/run） | ✅ `SubmitAutoRiggingJob`（A/T-pose 输入，可带 48 预设动作） | ✅ `animate_rig`（biped/quadruped 等 7 类，可先免费预检） | ❌ 无（`TAPose=true` + Quad 产绑骨就绪输入） |
| 动作 / 动画 | ✅ animations（静态动作目录 0–696，约 690 条） | ✅ 绑骨内置 48 预设动作 + 文生动作 | ✅ `animate_retarget`（16 个 `preset:*` 预设，一次最多 5 个） | ❌ 无 |
| 低模 / 重拓扑 | ✅ smart-topology（`meshy-t2`）+ 独立 Remesh API | ✅ `Submit3DSmartTopologyJob` + 减面 + `GenerateType=LowPoly` | ✅ P1 产品线 / `smart_low_poly` / `highpoly_to_lowpoly` | ⚠️ 仅生成时控面数（quality / quality_override / Sketch 档），无独立端点 |
| 贴图精修 | ✅ refine 追加贴图（`texture_image_url`） | ⚠️ 无直接对应（纹理生成 / 编辑近似替代） | ✅ `texture_model` | ✅ `rodin_texture_only`（模型 ≤10MB） |
| 余额查询 | ✅ `GET /openapi/v1/balance` | ⚠️ 无独立接口（TC3 任务查询响应含 `ResultCreditConsumed` / `ResultCreditDetails` 明细） | ✅ `GET /v2/openapi/user/balance` | ✅ `GET /api/v2/check_balance` |
| 接入门槛 | 注册即可（积分制） | 首开通送 100 积分；新能力逐步迁往 TokenHub | 注册送 300 积分（两周有效），积分永不过期 | **Business 订阅 $120/月**（更低档无 API access） |

**要点**：Meshy 能力最全（生成 / 精修 / 绑骨 / 动作全链路）；腾讯混元后处理强（绑骨 + 文生动作 + 智能拓扑）但需 TC3 密钥对，且输入文件要公网 URL；Tripo 生成档位多（含 P1 结构化低模产品线）但图片输入不支持 base64、需先上传；Rodin 仅覆盖生成 + 拆分（Bang）+ 重贴图，无绑骨 / 动作，订阅门槛最高 —— 定位为可选增强供应商。详细协议见 `docs/providers/`。

### Mock 模式

未配置 key 的 provider 一律自动回退**确定性 mock**（调用结果带 `usedMock: true`，`provider_not_configured` 不中断链路）：生成 / 精修 / 绑骨 / 动作 / 重拓扑的链路、资产落地、评分、合并导出都能跑通，但产物不是真实模型。看到 `usedMock: true` 时提示用户配置对应 key。已配置的 provider 正常直连，互不影响。

## 已知缺口

当前实现的已知能力边界（九条，每条含**影响 / 规避方式 / 后续计划**）见 [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)。要点速览：

- **Hunyuan 套动作**：`apply-motion` 的 Hunyuan 路由暂不可用——官方 48 预设动作目前只能绑骨时经 `motionType` 顺带，独立套动作待挂接 `SubmitHunyuanTo3DMotionJob`
- **Tripo 绑骨**：仅限 Tripo 自身生成的资产；外部 GLB 的 `import_model` 导入链路未实现
- **低模重拓扑**：真实路径需公网源 URL（无内置 COS / 模型上传链路），本地资产需用户自备直链
- **Rodin**：无绑骨 / 动作 / 重拓扑端点，且 API access 需 Business 订阅（$120/月）——定位为可选增强供应商
- **pose-standardization 暂缓**：官方无独立等价 API，未迁移

## 开发

> 运行时依赖（如 `@gltf-transform/core` 等）随 legacy 代码收口按需补充；`typescript` / `vitest` / `@types/node` 等 devDependencies 已就位。

```bash
pnpm install
pnpm build     # tsc -p tsconfig.json → lib/
pnpm test      # vitest run
```

## 布局

```
dsh-gen3d/
├── package.json          # npm 包 + dsh.bundle 元数据（patch → ./cordis.patch.yml）
├── cordis.patch.yml      # DSH 服务注入：id: gen3d
├── tsconfig.json
├── src/                  # 工具实现（ctx.tools.register(defineTool(...))）
│   ├── config.ts         # 凭证四层读取（readProviderKey 等，唯一密钥入口）
│   ├── storage.ts        # Gen3dStore 资产落盘 / 缓存 / 审计 / 锁
│   └── providers/        # 四家官方 API 直连（types 契约 + meshy / hunyuan3d / tripo3d / rodin）
├── skills/               # 随包分发的 agent 技能
└── docs/
    ├── KNOWN-GAPS.md     # 已知能力缺口（影响 / 规避 / 后续计划）
    ├── CREDENTIALS.md    # 凭证安全配置详细指南
    ├── dsh-api.md        # DSH 插件 API 精读
    └── providers/        # 四家官方 API 协议文档（meshy / hunyuan3d / tripo3d / rodin）
```

## 许可

MIT
