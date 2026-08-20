// 设置卡片 host 半边 —— gen3d 命名空间注册。
//
// 浏览器半边（src/client/）以同名命名空间 key 注册设置卡片，二者以
// 'gen3d' 为 join key（官方 settings.plugin.item 为 keyed 槽，见 docs/
// dsh-api.md 设置卡片章节）。本文件只负责命名空间 + schema：
// - 凭证引用缺省即 PROVIDER_ENV_KEYS（与 src/config.ts 注册表同源，单测钉死），
//   卡片读到的 resolved value 恒含四个引用；user 层字段"存在"即显式覆盖；
// - 解析后的引用经 setProviderRefSource() 接回 config.ts 的 providerEnvKeyOf()，
//   卡片改写引用后工具随之改读对应变量名；settings 服务缺席（headless 等
//   未挂载场景）时 installSettingsSection 整体不生效，引用源保持未注入，
//   工具密钥解析回退 PROVIDER_ENV_KEYS 缺省，行为与既往一致。

import type { Context } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

import { PROVIDER_ENV_KEYS, setProviderRefSource, type ProviderRefs } from './config.js';
import type { ProviderId } from './providers/types.js';

/** gen3d 设置命名空间（浏览器卡片以同 key 配对）。 */
export const GEN3D_SETTINGS_NAMESPACE = settingsNamespace('gen3d');

/** gen3d 设置节（四家供应商的凭证变量名引用；resolved 恒含四个缺省引用）。 */
export interface Gen3dSettings {
  meshyApiKeyEnv?: string;
  hunyuan3dApiKeyEnv?: string;
  tripo3dApiKeyEnv?: string;
  rodinApiKeyEnv?: string;
}

/** 供应商 → 节内字段名（与 PROVIDER_ENV_KEYS 一一对应）。 */
export const PROVIDER_SETTING_KEYS: Record<ProviderId, keyof Gen3dSettings> = {
  meshy: 'meshyApiKeyEnv',
  hunyuan3d: 'hunyuan3dApiKeyEnv',
  tripo3d: 'tripo3dApiKeyEnv',
  rodin: 'rodinApiKeyEnv',
};

/** 一节解析值 → config.ts 引用表（未显式声明的字段落 undefined，由缺省接管）。 */
export function providerRefsOf(section: Gen3dSettings): ProviderRefs {
  return {
    meshy: section.meshyApiKeyEnv,
    hunyuan3d: section.hunyuan3dApiKeyEnv,
    tripo3d: section.tripo3dApiKeyEnv,
    rodin: section.rodinApiKeyEnv,
  };
}

/** 四字段 schema：缺省引用即 PROVIDER_ENV_KEYS（schemastery 对象子键缺失时取 .default）。 */
export const Gen3dSettingsSchema: z<Gen3dSettings> = z.object({
  meshyApiKeyEnv: z.string().default(PROVIDER_ENV_KEYS.meshy),
  hunyuan3dApiKeyEnv: z.string().default(PROVIDER_ENV_KEYS.hunyuan3d),
  tripo3dApiKeyEnv: z.string().default(PROVIDER_ENV_KEYS.tripo3d),
  rodinApiKeyEnv: z.string().default(PROVIDER_ENV_KEYS.rodin),
});

/**
 * 装配设置卡片 host 半边：注册 gen3d 命名空间（composition entry 为空，
 * 缺省引用由 schema 承担），并把解析后的引用源接给 config.ts。
 * onChange 为空实现：工具侧除密钥引用外不派生任何节内配置。
 */
export function installGen3dSettingsSection(ctx: Context): void {
  installSettingsSection(ctx, GEN3D_SETTINGS_NAMESPACE, Gen3dSettingsSchema, {}, {
    setSource: (source) => {
      setProviderRefSource(() => providerRefsOf(source()));
    },
    onChange: () => {},
  });
}
