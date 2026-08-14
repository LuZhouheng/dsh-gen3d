import { test, expect } from 'vitest';
import { filterProviderParams, providerParamSpec } from './provider-params.js';

test('meshy text: keeps verified+applicable fields, drops unknown + deprecated', () => {
  const out = filterProviderParams('meshy', 'text', {
    ai_model: 'meshy-6',
    topology: 'quad',
    art_style: 'realistic', // deprecated → not in spec → dropped
    bogus: 'x', // unknown → dropped
  });
  expect(out).toEqual({ ai_model: 'meshy-6', topology: 'quad' });
});

test('meshy model_type only applies to image mode', () => {
  expect(filterProviderParams('meshy', 'text', { model_type: 'lowpoly' })).toEqual({});
  expect(filterProviderParams('meshy', 'image', { model_type: 'lowpoly' })).toEqual({
    model_type: 'lowpoly',
  });
});

test('meshy image: smart-topology + t2 + hd_texture pass filter', () => {
  expect(
    filterProviderParams('meshy', 'image', {
      model_type: 'smart-topology',
      ai_model: 'meshy-t2',
      hd_texture: true,
    }),
  ).toEqual({
    model_type: 'smart-topology',
    ai_model: 'meshy-t2',
    hd_texture: true,
  });
});

test('meshy P1 texture knobs pass filter for text/image', () => {
  const knobs = {
    texture_prompt: 'leather armor',
    texture_image_url: 'https://example.com/tex.png',
    remove_lighting: true,
  };
  expect(filterProviderParams('meshy', 'text', knobs)).toEqual(knobs);
  expect(filterProviderParams('meshy', 'image', knobs)).toEqual(knobs);
});

test('enum rejects invalid values; bool rejects non-bool', () => {
  expect(filterProviderParams('meshy', 'text', { ai_model: 'meshy-9' })).toEqual({});
  expect(filterProviderParams('meshy', 'text', { should_remesh: 'yes' as unknown as boolean })).toEqual(
    {},
  );
  expect(filterProviderParams('meshy', 'text', { should_remesh: true })).toEqual({
    should_remesh: true,
  });
});

test('rodin int clamps to range; quality enum validated', () => {
  expect(filterProviderParams('rodin', 'text', { quality_override: 5_000_000 })).toEqual({
    quality_override: 200000,
  });
  expect(filterProviderParams('rodin', 'text', { quality_override: 10 })).toEqual({
    quality_override: 1000,
  });
  expect(filterProviderParams('rodin', 'text', { quality: 'ultra' })).toEqual({});
  expect(filterProviderParams('rodin', 'text', { quality: 'high' })).toEqual({ quality: 'high' });
});

test('rodin use_original_alpha is image/views only', () => {
  expect(filterProviderParams('rodin', 'text', { use_original_alpha: true })).toEqual({});
  expect(filterProviderParams('rodin', 'image', { use_original_alpha: true })).toEqual({
    use_original_alpha: true,
  });
});

test('hunyuan_workflow has no advanced params (empty spec → {})', () => {
  expect(providerParamSpec.hunyuan_workflow).toEqual([]);
  expect(filterProviderParams('hunyuan_workflow', 'text', { anything: 1 })).toEqual({});
});

test('undefined raw → {}', () => {
  expect(filterProviderParams('meshy', 'text', undefined)).toEqual({});
});
