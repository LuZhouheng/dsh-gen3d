// 设置卡片 host 半边单测：命名空间品牌、schema 解析、缺省引用与
// PROVIDER_ENV_KEYS 的一致性、引用表映射。不碰真实 settings 服务（用
// schemastery 纯函数路径与 config.ts 引用源注入）。

import { afterEach, describe, expect, it } from 'vitest';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

import { PROVIDER_ENV_KEYS, providerEnvKeyOf, setProviderRefSource } from './config.js';
import {
  GEN3D_SETTINGS_NAMESPACE,
  Gen3dSettingsSchema,
  PROVIDER_SETTING_KEYS,
  providerRefsOf,
} from './settings.js';

afterEach(() => {
  setProviderRefSource(undefined);
});

describe('GEN3D_SETTINGS_NAMESPACE', () => {
  it('为品牌化的 gen3d 命名空间（合法 lowercase kebab）', () => {
    expect(GEN3D_SETTINGS_NAMESPACE).toBe('gen3d');
    expect(settingsNamespace('gen3d')).toBe('gen3d');
  });

  it('非法命名空间品牌化抛错（大小写 / 下划线 / 首字符数字）', () => {
    expect(() => settingsNamespace('Gen3d')).toThrow(/must match/);
    expect(() => settingsNamespace('gen_3d')).toThrow(/must match/);
    expect(() => settingsNamespace('3d')).toThrow(/must match/);
  });
});

describe('Gen3dSettingsSchema', () => {
  it('空节解析出四家缺省引用，与 PROVIDER_ENV_KEYS 逐项一致', () => {
    expect(Gen3dSettingsSchema({})).toEqual({
      meshyApiKeyEnv: PROVIDER_ENV_KEYS.meshy,
      hunyuan3dApiKeyEnv: PROVIDER_ENV_KEYS.hunyuan3d,
      tripo3dApiKeyEnv: PROVIDER_ENV_KEYS.tripo3d,
      rodinApiKeyEnv: PROVIDER_ENV_KEYS.rodin,
    });
  });

  it('undefined / null 输入同样解析出缺省引用', () => {
    expect(Gen3dSettingsSchema(undefined)).toEqual(Gen3dSettingsSchema({}));
    expect(Gen3dSettingsSchema(null)).toEqual(Gen3dSettingsSchema({}));
  });

  it('部分覆盖只改对应字段，其余保持缺省', () => {
    const value = Gen3dSettingsSchema({ meshyApiKeyEnv: 'MESH_KEY' });
    expect(value.meshyApiKeyEnv).toBe('MESH_KEY');
    expect(value.hunyuan3dApiKeyEnv).toBe(PROVIDER_ENV_KEYS.hunyuan3d);
    expect(value.tripo3dApiKeyEnv).toBe(PROVIDER_ENV_KEYS.tripo3d);
    expect(value.rodinApiKeyEnv).toBe(PROVIDER_ENV_KEYS.rodin);
  });

  it('非字符串引用被拒（类型错误落到字段路径）', () => {
    expect(() => Gen3dSettingsSchema({ meshyApiKeyEnv: 123 })).toThrow(/expected string/);
  });
});

describe('PROVIDER_SETTING_KEYS / providerRefsOf', () => {
  it('字段名与四家供应商一一对应', () => {
    expect(Object.keys(PROVIDER_SETTING_KEYS).sort()).toEqual(['hunyuan3d', 'meshy', 'rodin', 'tripo3d']);
    expect(PROVIDER_SETTING_KEYS.meshy).toBe('meshyApiKeyEnv');
    expect(PROVIDER_SETTING_KEYS.hunyuan3d).toBe('hunyuan3dApiKeyEnv');
    expect(PROVIDER_SETTING_KEYS.tripo3d).toBe('tripo3dApiKeyEnv');
    expect(PROVIDER_SETTING_KEYS.rodin).toBe('rodinApiKeyEnv');
  });

  it('providerRefsOf 把节映射为 config 引用表，未声明字段落 undefined', () => {
    expect(providerRefsOf({ meshyApiKeyEnv: 'MESH_KEY' })).toEqual({
      meshy: 'MESH_KEY',
      hunyuan3d: undefined,
      tripo3d: undefined,
      rodin: undefined,
    });
  });
});

describe('providerEnvKeyOf（设置节引用接线）', () => {
  it('未注入引用源时回退 PROVIDER_ENV_KEYS 缺省', () => {
    expect(providerEnvKeyOf('meshy')).toBe(PROVIDER_ENV_KEYS.meshy);
    expect(providerEnvKeyOf('hunyuan3d')).toBe(PROVIDER_ENV_KEYS.hunyuan3d);
    expect(providerEnvKeyOf('tripo3d')).toBe(PROVIDER_ENV_KEYS.tripo3d);
    expect(providerEnvKeyOf('rodin')).toBe(PROVIDER_ENV_KEYS.rodin);
  });

  it('注入引用源后按节引用解析；空串回退缺省', () => {
    setProviderRefSource(() => ({ meshy: 'MESH_KEY', hunyuan3d: '' }));
    expect(providerEnvKeyOf('meshy')).toBe('MESH_KEY');
    expect(providerEnvKeyOf('hunyuan3d')).toBe(PROVIDER_ENV_KEYS.hunyuan3d);
    expect(providerEnvKeyOf('tripo3d')).toBe(PROVIDER_ENV_KEYS.tripo3d);
    expect(providerEnvKeyOf('rodin')).toBe(PROVIDER_ENV_KEYS.rodin);
  });

  it('清除引用源后回到缺省（settings 服务缺席/卸载路径）', () => {
    setProviderRefSource(() => ({ meshy: 'MESH_KEY' }));
    expect(providerEnvKeyOf('meshy')).toBe('MESH_KEY');
    setProviderRefSource(undefined);
    expect(providerEnvKeyOf('meshy')).toBe(PROVIDER_ENV_KEYS.meshy);
  });
});
