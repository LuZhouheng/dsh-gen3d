# 凭证安全配置指南（dsh-gen3d）

本文档是 dsh-gen3d 四家直连供应商 API key 的**唯一权威配置参考**，与 `src/config.ts` 实现逐条对齐。

核心原则：**插件零内置 key**。所有真实生成调用都使用用户自行购买、配置的官方 key；未配置（或配置为空）时，provider 层抛 `provider_not_configured`，工具层回退**确定性 mock**（`usedMock: true`）——链路与资产落地照常跑通，但不产生真实模型、不消耗任何配额，也不会向任何第三方发出请求。

## 一、供应商凭证总览

| 供应商 | 变量名 | 获取入口 | 门槛 / 计费 | 用途 |
| --- | --- | --- | --- | --- |
| Meshy | `MESHY_API_KEY` | [platform.meshy.ai](https://platform.meshy.ai) 登录 → Settings → API（API settings 页）→ Create API Key | 注册即可；积分制 | 生成 / 精修 / 绑骨 / 动作全链路 |
| 腾讯混元 3D（生成） | `HUNYUAN3D_API_KEY` | [TokenHub 控制台](https://cloud.tencent.com/document/product/1823/132252) 创建 API Key | 首次开通送 100 免费积分；积分制 | TokenHub 路径：文生 / 图生 / 多视图生 3D |
| 腾讯混元 3D（后处理） | `HUNYUAN3D_SECRET_ID` + `HUNYUAN3D_SECRET_KEY` | 腾讯云控制台 → 访问管理 → API 密钥管理（CAM） | 同上（积分制） | TC3 签名路径（腾讯云 API 3.0）：**绑骨 / 文生动作 / 智能拓扑等后处理能力必需** |
| Tripo3D | `TRIPO3D_API_KEY` | [platform.tripo3d.ai/api-keys](https://platform.tripo3d.ai/api-keys) | 注册送 300 积分（两周有效），积分永不过期 | 生成 / 绑骨 / 动作 / 低模 / 贴图 |
| Rodin（Hyper3D） | `RODIN_API_KEY` | [hyper3d.ai](https://hyper3d.ai) 登录 → API Key Management → "+Create new API Keys" | **Business 订阅（$120/月）起**才有 API access | 生成 / 拆分（Bang）/ 重贴图 |

各家 key 格式与注意点：

- **Meshy**：官方未记载格式（社区流传 `msy-` 前缀，不作依据）；key 只显示一次，可随时吊销，可按用途建多个 key 分别统计用量。
- **Hunyuan3D（TokenHub）**：Bearer 直用；TokenHub 仅覆盖生成类，绑骨 / 文生动作 / 智能拓扑等后处理**只有 TC3 路径**（即需要 `HUNYUAN3D_SECRET_ID` / `HUNYUAN3D_SECRET_KEY`）。注意官方公告：混元能力逐步迁移至 TokenHub，原平台停止新购模型服务——新开户走 TokenHub。
- **Tripo3D**：key 以 `tsk_` 开头；`tcli_` 开头的 Client ID 仅标识应用，**拿 Client ID 请求会全部 401**。任务查询强绑定创建时的同一把 key。
- **Rodin**：key 只显示一次，创建后立即保存，丢失需重新生成；Free / Creator 订阅无 API access，`SUBSCRIPTION_PLAN_TOO_LOW` 即此原因，状态界面会提示。

## 二、读取优先级（四层）

与 DSH credentials-local 四层一致（`src/config.ts` `loadCredentialLayers()`）：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1（最高） | **环境变量**（`process.env`） | 总是胜出，遮蔽所有文件配置；空串视为未配置 |
| 2 | `$DSH_HOME/.credentials.yaml` | 推荐配置位置；胜过两个 `.env` 层 |
| 3 | `<cwd>/.env` | 工作区级 `.env`（`.env` 子集解析） |
| 4（最低） | `$DSH_HOME/.env` | 用户级 `.env` |

`$DSH_HOME` 未设置时默认 `~/.dsh`。低优先级先加载、高优先级覆盖合并；**空字符串一律视为未配置**（与 DSH「空存储值即缺席」一致）。

## 三、配置方式

### 3.1 `$DSH_HOME/.credentials.yaml`（推荐）

解析器（自实现 YAML 子集）**兼容两种形态**，只认扁平映射，其余 YAML 特性（数组 / 嵌套 / 流式映射）不支持：

```yaml
# 形态一（权威）：根映射 —— 与 DSH credentials-local 标准一致，推荐
MESHY_API_KEY: "meshy-xxxxxxxx"
HUNYUAN3D_API_KEY: "xxxxxxxx"
HUNYUAN3D_SECRET_ID: "AKIDxxxxxxxx"     # 可选：腾讯云后处理（TC3）
HUNYUAN3D_SECRET_KEY: "xxxxxxxx"        # 可选：腾讯云后处理（TC3）
TRIPO3D_API_KEY: "tsk_xxxxxxxx"
RODIN_API_KEY: "xxxxxxxx"
```

```yaml
# 形态二（兼容）：顶层 credentials: 包裹一层，与根映射等价
credentials:
  MESHY_API_KEY: "meshy-xxxxxxxx"
```

> 形态二是早期 README 示例遗留的写法，解析器为向后兼容保留；新配置请用形态一。两种形态解析结果完全一致，不要同时用两种形态写同一个 key（后者会覆盖前者，键名相同时以文件内靠后的行为准）。

### 3.2 `.env`（工作区 / 用户级）

`<cwd>/.env` 与 `$DSH_HOME/.env` 均支持 `.env` 子集（`KEY=VALUE` 行、单双引号包裹、整行注释）：

```bash
MESHY_API_KEY=meshy-xxxxxxxx
TRIPO3D_API_KEY=tsk_xxxxxxxx
```

### 3.3 环境变量（最高优先级）

```bash
export MESHY_API_KEY="meshy-xxxxxxxx"
export HUNYUAN3D_API_KEY="xxxxxxxx"
export TRIPO3D_API_KEY="tsk_xxxxxxxx"
export RODIN_API_KEY="xxxxxxxx"
```

环境变量只读、不可被插件改写；同一 ref 被环境变量供应时，文件层的同名配置被遮蔽。

### 3.4 实时生效

每次调用**实时重读文件、不跨操作缓存**——轮换 / 吊销的 key 无需重启 DSH 即生效。但注意：进程环境变量在 shell 导出后，改动需要重新 export 才生效。

## 四、掩码与展示

- `redactKey()`（`src/config.ts`）：长度 ≤8 一律 `***`；否则显示前 4 位 + `…` + 后 4 位（如 `sk-abcd…wxyz`）。
- **任何输出**（provider-status、日志、审计、错误信息、原始响应回显）**都不得打印完整密钥**；provider 的 `raw` 回显按契约「不得包含任何可打印的密钥」。
- `providerConfiguredMap()` 只暴露布尔（是否配置），不带值。

## 五、安全实践

1. **key 不进仓库**：`.credentials.yaml`、`.env`、含 key 的 shell 脚本一律加入 `.gitignore`，不提交、不进 commit message、不进截图文件名、不进日志与 agent 记忆。`dsh-gen3d` 仓库只含变量名引用（如本文件），不含任何真实值。
2. **文件权限**：建议 `$DSH_HOME` 目录 `0700`、`.credentials.yaml` 文档 `0600`（对齐 DSH credentials-local 标准；插件自实现解析器不强制校验权限，但同 OS 用户均可读是客观事实，模型侧不可读不靠文件权限保证，而是靠「插件从不把 key 装进工具上下文」的工程纪律）。
3. **最小权限与轮换**：按用途建多个 key（Meshy / Rodin 官方支持多 key 与吊销）；泄露或疑似泄露立即在控制台吊销重建——插件实时重读，吊销即时生效。
4. **公司网关已移除**：本插件**不再经公司内部 LiteLLM 网关转发**，key 只发给各家官方域名：
   - Meshy：`https://api.meshy.ai`
   - 腾讯混元：`https://tokenhub.tencentmaas.com`（生成）、`https://ai3d.tencentcloudapi.com`（TC3 后处理，国际版 `hunyuan.intl.tencentcloudapi.com`）
   - Tripo3D：`https://api.tripo3d.ai`
   - Rodin：`https://api.hyper3d.com`
   - 资产下载：各家签名的临时 URL（Meshy / 腾讯 COS / Tripo S3 / Rodin 直链），拿到即下载，无额外凭证。
5. **未配置时的行为**：某家未配置 → 该 provider 抛 `provider_not_configured`，工具层回退确定性 mock（结果带 `usedMock: true`），并在状态界面提示「配置 key 后启用真实生成」。**不会**因为缺 key 悄悄调用别的供应商或第三方服务。

## 六、验证

1. `gen3d:provider-status`：显示四家配置状态（布尔）+ 脱敏尾缀，不打印完整 key。
2. 命令行冒烟（可选，用环境变量引用，不落盘真实 key）：

```bash
curl https://api.meshy.ai/openapi/v1/balance -H "Authorization: Bearer ${MESHY_API_KEY}"
curl https://api.tripo3d.ai/v2/openapi/user/balance -H "Authorization: Bearer ${TRIPO3D_API_KEY}"
curl https://api.hyper3d.com/api/v2/check_balance -H "Authorization: Bearer ${RODIN_API_KEY}"
```

> 腾讯混元无独立余额查询接口：TC3 路径可在任务查询响应中看到 `ResultCreditConsumed` / `ResultCreditDetails`（详见 `docs/providers/hunyuan3d-api.md` §5.1）；TokenHub 路径的余额 / 消耗以 TokenHub 控制台为准。
