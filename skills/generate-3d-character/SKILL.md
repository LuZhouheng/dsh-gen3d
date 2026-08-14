---
name: generate-3d-character
description: 从一句需求或一张参考图生成一个带贴图、游戏可用的 3D 角色资产。默认只交付静态角色；只有用户明确要它「会动」才绑骨 + 套动作（按次计费）。当用户要一个 3D 角色（人形 / 生物）时调用。
---

# Generate a 3D Character

## When to use

- 用户要一个 3D **角色**资产（人形 / 生物），文生 / 图生 / 多视图都行
- 已有一个静态角色，用户明确说「让它动起来」（走 / 跑 / 挥手）要绑骨 + 套动作
- 不要用它做道具 / 小物件（那是别的 2D/道具工具）或程序化 CAD

## Procedure

> **默认只做到「静态角色」就交付。** 绑骨 / 动作要花真钱（按次计费），**只在用户明确要它会动时**才做。

1. **确认前置**：先确认当前 DSH 工作区（产物落 `assets/3d/` 下，工具调用无需额外传项目标识）。先 `gen3d_provider_status` 看 provider 能力 / 配置（未配 key 会显示回退 mock）。
2. **生成静态角色**：`gen3d_text_to_3d` / `gen3d_image_to_3d` / `gen3d_views_to_3d`（默认 provider = Meshy，可切 Hunyuan3D / Tripo3D / Rodin）。输入图尽量用已摆好 A/T-pose 的全身参考图；Meshy 文生想加贴图用 `gen3d_refine_mesh`。
3. **评分**：`gen3d_score_quality` 跑客观五维（geometry / topology / texture / pbr / prompt_fidelity），判断要不要重生成或换 provider。
4. **命名 + 交付**：`gen3d_rename_asset` 给清晰显示名（只改显示名不动磁盘），把静态角色的资产路径回报给用户。
5. **交付时主动补一句（必做）**：告诉用户「这个角色现在是静态的；想让它**会动**（走 / 跑 / 挥手）我可以帮它绑骨 + 加动作，但要花一点配额——需要就说一声」。
6. **仅当用户明确要会动**（仅人形 `characters` 槽）：`gen3d_auto_rig` 绑骨（保贴图、置位 `readiness.rigged`）→ `gen3d_list_motions`（按 `query`/`category`/`rigType` 收窄）挑动作 → `gen3d_apply_motion`（一次一个动作，按动作幂等）。

## Examples

- ✅ 「一个红斗篷骑士」→ text-to-3d → score-quality → rename → 交资产路径 + 提示「要不要让它动」
- ✅ 用户给一张角色全身图（已摆好 A/T-pose）→ image-to-3d → 交付静态
- ✅ 用户「让骑士走起来」→ auto-rig → list-motions(query=walk) → apply-motion
- ❌ 用户只要个静态展示，却自作主张 auto-rig + apply-motion —— 白烧配额
- ❌ 给非人形（道具 / 怪物座骑）硬 auto-rig —— 软门控会拒，别硬试

## Anti-patterns

- 不要漏掉前置确认就开跑——产物归属 / provider 状态没确认前别闷头生成。
- 不要默认就绑骨 / 套动作——静态优先，会动是 opt-in、按次计费。
- 一次只套一个动作；命中 cache 会复用旧资产**并忽略新名字**（预期行为）。
- `rig_task_id` 约 3 天过期；套动作报 `rig_expired` 时由用户决定，只有显式 `autoReRig` 才自动重绑（再扣配额）。
- 资产状态走结构化字段（`motionRef` 等），**不要靠解析文件名**判断。
- 未配置 key 时调用会回退确定性 mock（`usedMock: true`）——跑得通但产物不是真模型，交付前提示用户配 key。
- 不接道具 / 小物件、不接程序化 CAD、不写引擎代码。
