// 编码层 —— RGBA 帧 → 图像文件字节。
//
// - PNG：pngjs 同步编码（PNG.sync.write；一张 contact-sheet 拼图）。
// - GIF：gifenc 多帧动图（每帧 256 色量化 + 调色板 + 局部色表写入；
//   turntable 循环播放，帧延迟 140ms ≤ 画面节奏即可，repeat=0 无限循环）。
//
// 两个依赖都是零外部运行时依赖的纯 JS 库；编码必须同步（工具层落盘 &
// saveImage 前就地完成，不需要后台任务）。

import { PNG } from 'pngjs';
import * as gifencNs from 'gifenc';
// gifenc 的 package.json 没有 exports 字段，双环境解析到不同构建：
// - Node ESM（插件运行期）解析 main = CJS dist：命名导出被 cjs-module-lexer
//   拒收（Named export 'GIFEncoder' not found），namespace 上只有
//   default = module.exports；
// - vite/vitest 解析 module = ESM dist：具名导出直挂 namespace，
//   default 反而 = GIFEncoder 函数本身。
// 按形状二选一：namespace 上有 GIFEncoder 用 namespace，否则取 default。
const gifenc = (gifencNs as unknown as { GIFEncoder?: unknown; default?: unknown }).GIFEncoder
  ? gifencNs
  : ((gifencNs as unknown as { default: typeof gifencNs }).default as typeof gifencNs);
const { GIFEncoder, applyPalette, quantize } = gifenc;

import type { RenderFrame } from './soft-renderer.js';

/** RGBA 帧 → PNG 字节（pngjs 同步路径）。 */
export function encodePng(frame: RenderFrame): Uint8Array {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

/** 多帧 RGBA → GIF 动图字节（256 色/帧局部调色板；repeat=0 无限循环）。 */
export function encodeGif(frames: readonly RenderFrame[], delayMs = 140): Uint8Array {
  if (frames.length === 0) {
    throw new Error('encodeGif 需要至少 1 帧');
  }
  const gif = GIFEncoder();
  for (const frame of frames) {
    const palette = quantize(frame.rgba, 256, { format: 'rgb565' });
    const index = applyPalette(frame.rgba, palette);
    gif.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: delayMs,
      repeat: 0,
    });
  }
  gif.finish();
  return gif.bytes();
}
