// 凭证解析单测：四层优先级、YAML / .env 子集解析、脱敏、混元签名预留键。
// 全部经 options 注入隔离目录与 env，不触碰真实 process.env / 用户主目录。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HUNYUAN3D_SECRET_ID_ENV,
  HUNYUAN3D_SECRET_KEY_ENV,
  PROVIDER_ENV_KEYS,
  dshHomeDir,
  isProviderConfigured,
  loadCredentialLayers,
  parseCredentialsYaml,
  parseDotEnv,
  providerConfiguredMap,
  readHunyuanSecretId,
  readHunyuanSecretKey,
  readProviderKey,
  redactKey,
  type ConfigOptions,
} from '../src/config.js';

let tmp: string;

function makeOptions(overrides: Partial<ConfigOptions> = {}): ConfigOptions {
  return {
    dshHome: join(tmp, 'dsh'),
    cwd: join(tmp, 'cwd'),
    env: { DSH_HOME: join(tmp, 'dsh') },
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-gen3d-config-'));
  // 预建 dshHome / cwd 目录，保证测试环境与真实环境同构
  mkdirSync(join(tmp, 'dsh'), { recursive: true });
  mkdirSync(join(tmp, 'cwd'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseDotEnv', () => {
  it('解析 KEY=VALUE，支持引号与整行注释，跳过坏行', () => {
    const parsed = parseDotEnv(
      [
        '# 注释',
        'MESHY_API_KEY=sk-plain',
        'HUNYUAN3D_API_KEY="tok-quoted"',
        "TRIPO3D_API_KEY='trip-quoted'",
        'EMPTY=',
        'not a valid line',
        'RODIN_API_KEY= rodin-ok ',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      MESHY_API_KEY: 'sk-plain',
      HUNYUAN3D_API_KEY: 'tok-quoted',
      TRIPO3D_API_KEY: 'trip-quoted',
      RODIN_API_KEY: 'rodin-ok',
    });
    expect(parsed['EMPTY']).toBeUndefined(); // 空串视为未配置
  });
});

describe('parseCredentialsYaml', () => {
  it('权威形态：根映射直接是 KEY: value（含引号与注释）', () => {
    const parsed = parseCredentialsYaml(
      [
        '# dsh credentials',
        'MESHY_API_KEY: sk-meshy-123',
        'HUNYUAN3D_API_KEY: "tok-hunyuan-456" # 行尾注释',
        "TRIPO3D_API_KEY: 'trip-789'",
        'RODIN_API_KEY:',
        'OTHER_THING: 42',
      ].join('\n'),
    );
    expect(parsed['MESHY_API_KEY']).toBe('sk-meshy-123');
    expect(parsed['HUNYUAN3D_API_KEY']).toBe('tok-hunyuan-456');
    expect(parsed['TRIPO3D_API_KEY']).toBe('trip-789');
    expect(parsed['RODIN_API_KEY']).toBeUndefined(); // 空值视为未配置
    expect(parsed['OTHER_THING']).toBe('42');
  });

  it('兼容形态：credentials: 包裹一层映射', () => {
    const parsed = parseCredentialsYaml(
      ['credentials:', '  MESHY_API_KEY: sk-nested', '  HUNYUAN3D_API_KEY: "tok-nested"'].join(
        '\n',
      ),
    );
    expect(parsed['MESHY_API_KEY']).toBe('sk-nested');
    expect(parsed['HUNYUAN3D_API_KEY']).toBe('tok-nested');
  });

  it('空文档 / 全注释 → 空映射', () => {
    expect(parseCredentialsYaml('')).toEqual({});
    expect(parseCredentialsYaml('# nothing\n\n')).toEqual({});
  });
});

describe('四层优先级', () => {
  it('process.env > $DSH_HOME/.credentials.yaml > cwd/.env > $DSH_HOME/.env', () => {
    writeFileSync(join(tmp, 'dsh', '.env'), 'MESHY_API_KEY=dsh-env-key\n');
    writeFileSync(join(tmp, 'cwd', '.env'), 'MESHY_API_KEY=cwd-env-key\n');
    writeFileSync(
      join(tmp, 'dsh', '.credentials.yaml'),
      'MESHY_API_KEY: yaml-key\nTRIPO3D_API_KEY: tripo-yaml\n',
    );
    const options = makeOptions({ env: { DSH_HOME: join(tmp, 'dsh'), MESHY_API_KEY: 'process-key' } });

    expect(readProviderKey('meshy', options)).toBe('process-key'); // 层 1 胜出
    expect(readProviderKey('tripo3d', options)).toBe('tripo-yaml'); // 层 2（env 无此键）
    // 去掉 env 中的 meshy 键后：credentials.yaml（层 2）胜过两个 .env
    const noEnvMeshy = makeOptions({ env: { DSH_HOME: join(tmp, 'dsh') } });
    expect(readProviderKey('meshy', noEnvMeshy)).toBe('yaml-key');
    // 去掉 credentials.yaml 后：cwd/.env（层 3）胜过 $DSH_HOME/.env
    rmSync(join(tmp, 'dsh', '.credentials.yaml'));
    expect(readProviderKey('meshy', noEnvMeshy)).toBe('cwd-env-key');
    // 去掉 cwd/.env 后，回落到 $DSH_HOME/.env（层 4）
    rmSync(join(tmp, 'cwd', '.env'));
    expect(readProviderKey('meshy', noEnvMeshy)).toBe('dsh-env-key');
  });

  it('注入 env 整体替换 process.env（不泄漏真实环境变量）', () => {
    writeFileSync(join(tmp, 'dsh', '.credentials.yaml'), 'MESHY_API_KEY: yaml-key\n');
    const options = makeOptions({ env: {} });
    expect(readProviderKey('meshy', options)).toBe('yaml-key');
    // env 显式给空串 → 视为未配置，仍走下一层
    expect(readProviderKey('meshy', makeOptions({ env: { MESHY_API_KEY: '' } }))).toBe('yaml-key');
  });

  it('全部层缺失 → undefined；isProviderConfigured 判定一致', () => {
    const options = makeOptions({ env: {} });
    expect(readProviderKey('meshy', options)).toBeUndefined();
    expect(readProviderKey('hunyuan3d', options)).toBeUndefined();
    expect(readProviderKey('tripo3d', options)).toBeUndefined();
    expect(readProviderKey('rodin', options)).toBeUndefined();
    expect(isProviderConfigured('meshy', options)).toBe(false);
  });

  it('providerConfiguredMap 只返回布尔（四家）', () => {
    writeFileSync(join(tmp, 'dsh', '.credentials.yaml'), 'RODIN_API_KEY: rodin-yaml\n');
    const map = providerConfiguredMap(makeOptions({ env: { MESHY_API_KEY: 'sk-x' } }));
    expect(map).toEqual({ meshy: true, hunyuan3d: false, tripo3d: false, rodin: true });
  });
});

describe('Hunyuan3D 预留签名凭据', () => {
  it('HUNYUAN3D_SECRET_ID / HUNYUAN3D_SECRET_KEY 走同一优先级链', () => {
    writeFileSync(
      join(tmp, 'dsh', '.credentials.yaml'),
      'HUNYUAN3D_SECRET_ID: sid-yaml\nHUNYUAN3D_SECRET_KEY: skey-yaml\n',
    );
    const options = makeOptions({ env: {} });
    expect(readHunyuanSecretId(options)).toBe('sid-yaml');
    expect(readHunyuanSecretKey(options)).toBe('skey-yaml');
    // env 优先级
    const withEnv = makeOptions({
      env: { [HUNYUAN3D_SECRET_ID_ENV]: 'sid-env', [HUNYUAN3D_SECRET_KEY_ENV]: 'skey-env' },
    });
    expect(readHunyuanSecretId(withEnv)).toBe('sid-env');
    expect(readHunyuanSecretKey(withEnv)).toBe('skey-env');
  });
});

describe('dshHomeDir / 变量名注册表', () => {
  it('变量名映射与公共约定一致', () => {
    expect(PROVIDER_ENV_KEYS).toEqual({
      meshy: 'MESHY_API_KEY',
      hunyuan3d: 'HUNYUAN3D_API_KEY',
      tripo3d: 'TRIPO3D_API_KEY',
      rodin: 'RODIN_API_KEY',
    });
  });

  it('options.dshHome 优先；其次注入 env 的 DSH_HOME；都无则 ~/.dsh', () => {
    expect(dshHomeDir(makeOptions({ dshHome: '/x/custom' }))).toBe('/x/custom');
    // 显式把 dshHome 置空后，才轮到注入 env 的 DSH_HOME
    expect(dshHomeDir(makeOptions({ dshHome: undefined, env: { DSH_HOME: '/y/home' } }))).toBe('/y/home');
    // 无注入时回退主目录（只验证形式）
    expect(dshHomeDir({})).toMatch(/\.dsh$/);
  });
});

describe('redactKey', () => {
  it('脱敏展示：只露首尾各 4 字符', () => {
    expect(redactKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
    expect(redactKey('short')).toBe('***');
  });
});

describe('loadCredentialLayers', () => {
  it('合并表按优先级覆盖，且不含环境里的无关键注入', () => {
    writeFileSync(join(tmp, 'dsh', '.env'), 'A=dsh-a\nB=dsh-b\n');
    writeFileSync(join(tmp, 'cwd', '.env'), 'B=cwd-b\n');
    writeFileSync(join(tmp, 'dsh', '.credentials.yaml'), 'C: yaml-c\n');
    const merged = loadCredentialLayers(makeOptions({ env: { A: 'env-a', D: 'env-d' } }));
    expect(merged['A']).toBe('env-a'); // env 覆盖 dsh/.env
    expect(merged['B']).toBe('cwd-b'); // cwd/.env 覆盖 dsh/.env
    expect(merged['C']).toBe('yaml-c');
    expect(merged['D']).toBe('env-d');
  });
});
