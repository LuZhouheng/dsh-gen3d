// gen3d 设置卡片 / 3D 资产视窗 / 工具卡片 —— 浏览器半边注册入口（dsh.client
// 双面包的 client 面）。
//
// 注册进官方 keyed 槽 settings.plugin.item，key = 'gen3d'（与 host 半边
// src/settings.ts 命名空间同名配对；tab 按「serve 集合 ∩ 槽账本」分发卡片）。
// 另注册两处官方槽位：
//   - conversation.view（list 槽）：会话页签「3D 资产」（trajectory 同款先例）；
//   - tool.call.toolview（keyed 槽）：gen3d 工具的逐调用行卡片（entryKey=工具名）。
// 只做 type-only 跨包导入（bundle 纯度门），运行时协作全走 cordis 服务；
// 本面产物由 client-modules 按 package.json 的 dsh.client 声明自动服务到
// /plugins/dsh-gen3d/client.js，无需重编 web 应用（官方 cookbook 原话）。
//
// 类型桥接说明：'conversation.view' 与 'tool.call.toolview' 的 SlotMap 契约分别
// 由 @deepseek-ai/dsh-client-ui-conversation 与 @deepseek-ai/dsh-client-ui-tool
// 的 client 类型声明（lib/types/client/contract/slots.d.ts）增广，而这两个包不在
// 本仓库 devDependencies（slots 增广注册表里只有 settings 两包 + runtime）。
// 按约定（不因类型加依赖）：槽位契约以结构镜像本地化（见 ViewerTab.tsx /
// tool-cards.tsx 文件头注释），注册参数经窄化桥接——形状已逐字段对齐官方声明，
// 且 slots.register 装载期做 load-time 校验（未声明槽 / keyed 缺 key / list 缺
// id 都 fail loud），任何偏移都会在装配期抛错（与 src/index.ts 的 toToolDefinition
// defineTool as never 桥接同理）。

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// Type-only：ctx.settingsScope 声明 + settings.plugin.item 槽声明（值导入会
// 炸掉 client bundle 纯度门；跨插件协作一律经 cordis 服务）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';

import { Gen3dCard } from './Gen3dCard.js';
import { GEN3D_CARD_KEY, Gen3dCardController } from './gen3d-card-controller.js';
import { GEN3D_TOOLVIEW_ENTRIES } from './tool-cards.js';
import { ViewerTab } from './viewer/ViewerTab.js';

/** 需要的服务：slots（槽注册）/ connection（凭证 wire 面）/ settingsScope（设置节）。 */
export const inject = ['slots', 'connection', 'settingsScope'];

/** slots 服务的窄化面（类型桥接边界：见文件头【类型桥接说明】）。 */
interface SlotsBridge {
  inject(key: string, callback: () => () => void): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

function slotsOf(ctx: ClientContext): SlotsBridge {
  return ctx.slots as unknown as SlotsBridge;
}

function applySettingsCard(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle;
  const card = new Gen3dCardController(ctx.settingsScope.bind({ namespace: GEN3D_CARD_KEY }), api);
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: GEN3D_CARD_KEY,
    inject: () => card.inject(),
  }, Gen3dCard));
}

/** 会话页签「3D 资产」：list 槽，id='gen3d'，order=20（trajectory 先例 order=10）。 */
function applyViewerTab(ctx: ClientContext): void {
  // slots.inject 等候槽声明（ui-conversation 注册 conversation.session 时提交
  // 子槽声明），声明后回调立即执行并注册；插件卸载连坐清理——与官方 trajectory
  // 的 slots.inject 链路同款，无 slots 环境则整个 client 面不装配（现有设置卡片
  // 同款防御：服务列表硬要求，失败即插件不挂载）。
  slotsOf(ctx).inject('conversation.view', () => slotsOf(ctx).register({
    name: 'conversation.view',
    id: 'gen3d',
    order: 20,
    label: '3D 资产',
  }, ViewerTab));
}

/** gen3d 工具的 keyed 工具卡片（entryKey = wire 工具名；未注册的 key 走平台默认行）。 */
function applyToolCards(ctx: ClientContext): void {
  slotsOf(ctx).inject('tool.call.toolview', () => {
    const disposers = GEN3D_TOOLVIEW_ENTRIES.map((entry) =>
      slotsOf(ctx).register({
        name: 'tool.call.toolview',
        key: entry.key,
      }, entry.component),
    );
    return () => { for (const dispose of disposers) dispose() };
  });
}

export function apply(ctx: ClientContext): void {
  applySettingsCard(ctx);
  applyViewerTab(ctx);
  applyToolCards(ctx);
}
