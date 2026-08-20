// gen3d 设置卡片 —— 浏览器半边注册入口（dsh.client 双面包的 client 面）。
//
// 注册进官方 keyed 槽 settings.plugin.item，key = 'gen3d'（与 host 半边
// src/settings.ts 命名空间同名配对；tab 按「serve 集合 ∩ 槽账本」分发卡片）。
// 只做 type-only 跨包导入（bundle 纯度门），运行时协作全走 cordis 服务；
// 本面产物由 client-modules 按 package.json 的 dsh.client 声明自动服务到
// /plugins/dsh-gen3d/client.js，无需重编 web 应用（官方 cookbook 原话）。

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
// Type-only：ctx.settingsScope 声明 + settings.plugin.item 槽声明（值导入会
// 炸掉 client bundle 纯度门；跨插件协作一律经 cordis 服务）。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client';

import { Gen3dCard } from './Gen3dCard.js';
import { GEN3D_CARD_KEY, Gen3dCardController } from './gen3d-card-controller.js';

/** 需要的服务：slots（槽注册）/ connection（凭证 wire 面）/ settingsScope（设置节）。 */
export const inject = ['slots', 'connection', 'settingsScope'];

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle;
  const card = new Gen3dCardController(ctx.settingsScope.bind({ namespace: GEN3D_CARD_KEY }), api);
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: GEN3D_CARD_KEY,
    inject: () => card.inject(),
  }, Gen3dCard));
}
