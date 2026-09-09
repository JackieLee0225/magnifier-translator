'use strict';

/**
 * capture.js —— 屏幕区域截图
 *
 * 【改造前的问题】
 * 1. thumbnailSize 传 size*scaleFactor，再拿 scaleFactor 去 crop，等于把缩放
 *    算了两遍；Electron 还可能不给到请求的那么大，导致裁切位置漂移。
 * 2. 只取 sources[0]，多显示器时永远截主屏。
 *
 * 【现在的做法】
 * 主方案用 macOS 自带的 /usr/sbin/screencapture：
 *   - -R 接受的就是全局屏幕坐标（点单位，原点在主屏左上角），和 Electron
 *     的 screen 坐标系完全一致，不需要自己做任何缩放换算；
 *   - 输出自动是 Retina 原生分辨率，OCR 拿到的像素越多识别越准；
 *   - 系统自带，不增加任何依赖和打包体积。
 * 兜底方案保留 desktopCapturer，并且按实际返回尺寸反推真实缩放比。
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen } = require('electron');
const paths = require('./paths');
const log = require('./logger');

const execFileAsync = promisify(execFile);

/**
 * 生成一个临时 png 路径。
 * 目录由 paths.shotsDir() 统一解析（app.getPath('temp') 下的专属子目录），
 * 不再直接拼 temp 根目录——这样清理时不必遍历整个系统临时目录。
 * 文件名加随机后缀，避免同一毫秒内连续两次截图撞名。
 */
function tempPngPath() {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return path.join(paths.shotsDir(), `shot_${stamp}.png`);
}

/** 把矩形的浮点坐标规整成整数像素，并保证宽高至少为 1 */
function normalizeRect(rect) {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  };
}

/**
 * 主方案：调用系统 screencapture
 * -x 表示静音（不播放咔嚓声，也不闪动画）
 */
async function captureByScreencapture(rect) {
  const out = tempPngPath();
  const region = `${rect.x},${rect.y},${rect.width},${rect.height}`;

  await execFileAsync(paths.screencaptureBin(), ['-x', '-R', region, out], {
    timeout: 5000
  });

  // screencapture 失败时可能生成 0 字节文件，这里必须校验
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    throw new Error('screencapture 输出为空');
  }
  return out;
}

/**
 * 兜底方案：Electron desktopCapturer
 * 用实际拿到的缩略图尺寸反推缩放比，避免 scaleFactor 重复换算
 */
async function captureByDesktopCapturer(rect) {
  // 找出选区落在哪块显示器上
  const display = screen.getDisplayMatching(rect);
  const sf = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf)
    }
  });

  // display_id 是字符串，Display.id 是数字，比较前统一转字符串
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];

  if (!source) throw new Error('未找到可截图的屏幕源');

  const image = source.thumbnail;
  const real = image.getSize();

  // 真实缩放比 = 实际返回的像素宽 / 显示器逻辑宽（而不是直接信 scaleFactor）
  const ratioX = real.width / display.size.width;
  const ratioY = real.height / display.size.height;

  // 全局坐标 → 该显示器内的局部坐标
  const localX = rect.x - display.bounds.x;
  const localY = rect.y - display.bounds.y;

  const cropped = image.crop({
    x: Math.round(localX * ratioX),
    y: Math.round(localY * ratioY),
    width: Math.round(rect.width * ratioX),
    height: Math.round(rect.height * ratioY)
  });

  const out = tempPngPath();
  fs.writeFileSync(out, cropped.toPNG());
  return out;
}

/**
 * 截取指定屏幕区域
 * @param {{x:number,y:number,width:number,height:number}} rawRect 全局屏幕坐标
 * @returns {Promise<string>} 生成的 png 文件路径
 */
async function captureRegion(rawRect) {
  const rect = normalizeRect(rawRect);

  try {
    const p = await captureByScreencapture(rect);
    log.info('[capture] screencapture 成功:', p);
    return p;
  } catch (err) {
    log.warn('[capture] screencapture 失败，改用 desktopCapturer:', err.message);
    const p = await captureByDesktopCapturer(rect);
    log.info('[capture] desktopCapturer 成功:', p);
    return p;
  }
}

/**
 * 清理超过 1 小时的历史截图，避免临时目录堆积。
 *
 * 改动点：
 *  - 只扫自己的专属子目录，不再遍历整个系统临时目录（那里可能有上万个文件）
 *  - 每个文件单独 try/catch：以前整个循环共用一个 try，任意一个文件
 *    statSync 失败（权限不足、或文件刚被系统清理掉）就会中断整轮清理
 */
function cleanupOldShots() {
  let dir;
  let names;
  try {
    dir = paths.shotsDir();
    names = fs.readdirSync(dir);
  } catch {
    return; // 目录还不存在或读不了，直接跳过
  }

  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // 单个文件清理失败不影响其余文件
    }
  }
}

/**
 * 【权限实测探针】只用 screencapture 截 1×1 像素，成功即说明确实拿到了屏幕录制权限。
 *
 * 必须绕过 captureRegion 的降级链路：desktopCapturer 在无权限时往往返回一张黑图
 * 却不抛错，用它来探测会把「没权限」误判成「有权限」。这里只认 screencapture 的结果。
 *
 * @returns {Promise<boolean>} true = 权限可用
 */
async function probeScreencaptureAccess() {
  let out;
  try {
    out = await captureByScreencapture({ x: 0, y: 0, width: 1, height: 1 });
    return true;
  } catch {
    return false;
  } finally {
    if (out) fs.promises.unlink(out).catch(() => {});
  }
}

module.exports = { captureRegion, cleanupOldShots, probeScreencaptureAccess };
