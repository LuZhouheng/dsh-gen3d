// 工具卡片数据面单测：块 → 状态 / canonical value / 失败信封 / 预览路径 /
// 参数摘要。纯 TS 数据面，不渲染 React（与控制器测试同款：最小块构造）。

import { describe, expect, it } from 'vitest';

import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client';

import {
  argsSummary,
  canonicalValue,
  failureOf,
  metaOf,
  pickNumber,
  pickString,
  previewPathOf,
  resultText,
  settled,
  stateOf,
} from './tool-cards-model.js';

/** 最小运行中块（结构镜像 RunningToolCall）。 */
function running(argsRaw: string): RunningToolCall {
  return {
    callId: 'call-1',
    name: 'gen3d_text_to_3d',
    argsRaw,
    turn: 1,
    step: 1,
    time: 1,
    callView: null,
    subCalls: [],
  };
}

/** 最小定稿块（结构镜像 ToolResultNode）。 */
function done(content: Array<{ type: 'text'; text: string }>, extra?: Partial<ToolResultNode>): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 2,
    time: 2,
    callId: 'call-1',
    call: { name: 'gen3d_text_to_3d', argsRaw: '{}' },
    callTime: 1,
    content,
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
    ...extra,
  };
}

describe('stateOf / settled', () => {
  it('无 kind → running；有 kind → ok / error / interrupted', () => {
    expect(settled(running('{}'))).toBe(false);
    expect(stateOf(running('{}'))).toBe('running');
    expect(stateOf(done([{ type: 'text', text: '{}' }]))).toBe('ok');
    expect(stateOf(done([], { isError: true }))).toBe('error');
    expect(stateOf(done([], { error: { name: 'interrupted', code: 'interrupted' } }))).toBe('stopped');
  });
});

describe('canonicalValue / resultText', () => {
  it('从 text 块拼接后反解析 JSON', () => {
    const node = done([{ type: 'text', text: '{ "ok": true, "assetPath": "assets/3d/characters/hero.glb" }' }]);
    expect(canonicalValue(node)).toEqual({ ok: true, assetPath: 'assets/3d/characters/hero.glb' });
  });
  it('非 JSON 文本 → null（降级由卡片处理）', () => {
    expect(canonicalValue(done([{ type: 'text', text: '出了点事' }]))).toBeNull();
  });
  it('运行中 → null', () => {
    expect(canonicalValue(running('{}'))).toBeNull();
  });
  it('resultText 只拼 text 块', () => {
    const node = done([
      { type: 'text', text: '第一行' },
      { type: 'text', text: '第二行' },
    ]);
    expect(resultText(node)).toBe('第一行\n第二行');
  });
});

describe('metaOf', () => {
  it('结果 meta 为对象时取回，运行中 / 缺失 / 非对象为 null', () => {
    expect(metaOf(done([{ type: 'text', text: '{}' }], { meta: { previewPng: 'a.png' } })))
      .toEqual({ previewPng: 'a.png' });
    expect(metaOf(done([{ type: 'text', text: '{}' }]))).toBeNull();
    expect(metaOf(done([{ type: 'text', text: '{}' }], { meta: [1, 2] }))).toBeNull();
    expect(metaOf(running('{}'))).toBeNull();
  });
});

describe('failureOf', () => {
  it('ok:false 取失败信封', () => {
    expect(failureOf({ ok: false, code: 'provider_auth', message: 'key 无效', retryable: true }))
      .toEqual({ code: 'provider_auth', message: 'key 无效', retryable: true });
  });
  it('缺字段时给兜底值', () => {
    expect(failureOf({ ok: false, code: 1, message: 2 })).toEqual({
      code: 'unknown',
      message: '（无说明）',
      retryable: false,
    });
  });
  it('ok:true / null → null', () => {
    expect(failureOf({ ok: true })).toBeNull();
    expect(failureOf(null)).toBeNull();
  });
});

describe('previewPathOf', () => {
  it('识别 previewPng 键（png 字尾）', () => {
    expect(previewPathOf({ previewPng: '.dsh-gen3d/previews/hero-contact.png' }))
      .toBe('.dsh-gen3d/previews/hero-contact.png');
  });
  it('宽备键与 gif/webp 字尾', () => {
    expect(previewPathOf({ previewUrl: 'a/b/c.gif' })).toBe('a/b/c.gif');
    expect(previewPathOf({ previewImage: 'a/b/c.webp' })).toBe('a/b/c.webp');
  });
  it('无键 / 非字符串 / null → null', () => {
    expect(previewPathOf({})).toBeNull();
    expect(previewPathOf({ previewPng: 42 })).toBeNull();
    expect(previewPathOf(null)).toBeNull();
  });
});

describe('argsSummary', () => {
  it('优取 prompt / assetPath / assetName / provider', () => {
    expect(argsSummary(running('{ "prompt": "一只柴犬", "provider": "meshy" }'))).toBe('一只柴犬');
    expect(argsSummary(running('{ "assetPath": "assets/3d/meshes/cube.glb", "provider": "tripo3d" }')))
      .toBe('assets/3d/meshes/cube.glb');
  });
  it('字符串参数 JSON 兜底；无参数退 callId；超长截断', () => {
    expect(argsSummary(running('"just-text"'))).toBe('just-text');
    expect(argsSummary(running(''))).toBe('call-1');
    expect(argsSummary(running(`{ "prompt": "${'x'.repeat(80)}" }`))).toHaveLength(61);
  });
});

describe('pickString / pickNumber', () => {
  it('字符串与有限数字', () => {
    expect(pickString({ a: 'x', b: 1 }, 'a')).toBe('x');
    expect(pickString({ a: '' }, 'a')).toBeNull();
    expect(pickNumber({ n: NaN }, 'n')).toBeNull();
    expect(pickNumber({ n: 42 }, 'n')).toBe(42);
  });
});
