// 工具层汇总 —— 全部 gen3d 工具的注册清单（装配层把每个定义映射进
// ctx.tools.register(defineTool(...))，见 docs/dsh-api.md §2 / §9）。
//
// 工具命名：gen3d_<snake_case>（对应 legacy gen3d:*；DSH 函数式命名惯例）。
// 计费标记：billing: { credits } 供 tools/pre-execute 审批 gate 展示预计消耗
// （mock 回退不消耗配额）。

import type { Gen3dToolDefinition } from './common.js';
import { generationTools } from './generation.js';
import { animationTools } from './animation.js';
import { playableTools } from './playable.js';
import { gen3dRenderPreview } from './preview.js';
import { gen3dInspectAsset } from './inspect.js';

/** 全部 gen3d 工具定义（21 个）。 */
export const allGen3dTools: readonly Gen3dToolDefinition[] = [
  ...generationTools, // 11：provider_status / credentials_status / list_assets / delete_asset /
  // text_to_3d / image_to_3d / views_to_3d / refine_mesh / retopo_lowpoly / rename_asset / score_quality
  ...animationTools, // 3：auto_rig / apply_motion / list_motions
  ...playableTools, // 5：get/set_playable_profile / set_playable_motion_mapping /
  // export_playable_character / adopt_playable_character
  gen3dRenderPreview, // 1：render_preview（本地渲染，零配额）
  gen3dInspectAsset, // 1：inspect_asset（本地体检，零配额）
];

/** 计费工具名集合（审批 gate 可直接按名字过滤；等价于遍历 billing 元信息）。 */
export const billingToolNames: readonly string[] = allGen3dTools
  .filter((t) => t.billing !== undefined)
  .map((t) => t.name);
