'use strict';

/**
 * ocr.js —— 文字识别
 *
 * Step 1 接入 Apple Vision 原生 OCR：
 *   - 主引擎：调用 build/vision-ocr（Swift 编译的二进制），本地离线、中文准确率高；
 *   - 兜底引擎：Tesseract（网络/打包异常时仍可工作）。
 *
 * 调用方（main.js）只需要 recognize() / cleanText()，引擎切换对它是无感的。
 *
 * 统一返回结构：
 *   { text: string, engine: string, confidence: number }
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const Tesseract = require('tesseract.js');
const paths = require('./paths');

const execFileAsync = promisify(execFile);

/**
 * Apple Vision OCR（主引擎）
 * 二进制路径由 paths.visionBinary() 统一解析：
 *   打包后 → Resources/bin/vision-ocr（asar 外，可执行）
 *   开发期 → <项目根>/build/vision-ocr
 *
 * 返回里带 blocks（每行文字 + 像素坐标框），是「译文覆盖原文位置」的关键：
 * 镜片渲染时要把译文画在 blocks[i].bbox 那个位置。
 * @param {string} imagePath
 */
async function recognizeByVision(imagePath) {
  const bin = paths.visionBinary();
  const { stdout } = await execFileAsync(bin, [imagePath], { timeout: 15000 });

  if (!stdout.trim()) throw new Error('vision 输出为空');

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('vision 输出不是合法 JSON');
  }

  const text = (data.text || '').trim();

  // 把 Swift 输出的 blocks 规整成统一结构：{ text, bbox:{x,y,width,height} }
  // 坐标是左上原点、图片像素单位（与截图原生分辨率一致）。
  const blocks = Array.isArray(data.blocks)
    ? data.blocks
        .map((b) => ({
          text: String(b.text || '').trim(),
          bbox: {
            x: Number(b.bbox?.x || 0),
            y: Number(b.bbox?.y || 0),
            width: Number(b.bbox?.width || 0),
            height: Number(b.bbox?.height || 0)
          }
        }))
        .filter((b) => b.text && b.bbox.width > 0 && b.bbox.height > 0)
    : [];

  return {
    text,
    engine: 'vision',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    blocks
  };
}

/**
 * 把 Tesseract 的单词结果按 y 坐标聚合成「行」。
 * 某些版本/配置下 result.data.lines 可能缺失，这里用单词自己兜底分组，
 * 保证镜片模式始终能拿到行级坐标框。
 * @param {Array} words Tesseract 的 result.data.words（含 bbox:{x0,y0,x1,y1}）
 */
function groupWordsToLines(words) {
  if (!Array.isArray(words) || words.length === 0) return [];

  // 先按 y 中线、再按 x 排序，模拟阅读顺序
  const sorted = [...words].sort(
    (a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2
            || a.bbox.x0 - b.bbox.x0
  );

  const lines = [];
  let cur = null;
  for (const w of sorted) {
    const wb = w.bbox;
    const midY = (wb.y0 + wb.y1) / 2;
    const h = wb.y1 - wb.y0;
    // 与当前行中线相距超过半个行高 → 视为新的一行
    if (!cur || Math.abs(midY - cur.midY) > cur.height * 0.5) {
      // 新的一行：第一个词也要记进 texts，否则每行首词会丢
      cur = { texts: [w.text], x0: wb.x0, y0: wb.y0, x1: wb.x1, y1: wb.y1, midY, height: h };
      lines.push(cur);
    } else {
      cur.texts.push(w.text);
      cur.x0 = Math.min(cur.x0, wb.x0);
      cur.y0 = Math.min(cur.y0, wb.y0);
      cur.x1 = Math.max(cur.x1, wb.x1);
      cur.y1 = Math.max(cur.y1, wb.y1);
      cur.midY = (cur.y0 + cur.y1) / 2;
      cur.height = cur.y1 - cur.y0;
    }
  }

  return lines
    .map((l) => ({
      text: l.texts.join(' ').trim(),
      bbox: { x: l.x0, y: l.y0, width: l.x1 - l.x0, height: l.y1 - l.y0 }
    }))
    .filter((b) => b.text && b.bbox.width > 0 && b.bbox.height > 0);
}

/**
 * Tesseract OCR（降级兜底）
 * 同时返回行级坐标框 blocks，结构对齐 Vision。
 * @param {string} imagePath
 */
async function recognizeByTesseract(imagePath) {
  // ⚠️ cachePath 必须显式指定，否则是本次改造里最致命的一个坑：
  //    tesseract.js 默认 cachePath = '.'（当前工作目录），它会把下载来的
  //    chi_sim.traineddata（约 40MB）写到那里。终端 `npm start` 时 cwd 是
  //    项目目录，可写，一切正常；但用户从启动台/Finder 打开 .app 时
  //    cwd 是 "/"，根目录只读 → EACCES，兜底 OCR 直接失败。
  //    指到 userData 下的专属目录，每个用户各自独立且必定可写。
  const result = await Tesseract.recognize(imagePath, 'chi_sim+eng', {
    cachePath: paths.tessdataDir(),
    logger: (m) => {
      if (m.status === 'recognizing text') {
        console.log(`[ocr:tesseract] ${Math.round(m.progress * 100)}%`);
      }
    }
  });

  const text = (result.data.text || '').trim();

  // 优先用 Tesseract 自带的 lines；没有就自己用单词聚合成行
  let blocks = [];
  if (Array.isArray(result.data.lines) && result.data.lines.length) {
    blocks = result.data.lines
      .map((l) => ({
        text: String(l.text || '').trim(),
        bbox: {
          x: l.bbox.x0,
          y: l.bbox.y0,
          width: l.bbox.x1 - l.bbox.x0,
          height: l.bbox.y1 - l.bbox.y0
        }
      }))
      .filter((b) => b.text && b.bbox.width > 0 && b.bbox.height > 0);
  } else {
    blocks = groupWordsToLines(result.data.words);
  }

  return {
    text,
    engine: 'tesseract',
    confidence: typeof result.data.confidence === 'number'
      ? result.data.confidence / 100
      : 0,
    blocks
  };
}

/**
 * 识别图片中的文字（Vision 优先，失败自动降级 Tesseract）
 * @param {string} imagePath png 路径
 * @returns {Promise<{text:string, engine:string, confidence:number}>}
 */
async function recognize(imagePath) {
  const started = Date.now();

  // 先试 Vision
  try {
    const res = await recognizeByVision(imagePath);
    if (res.text) {
      console.log(
        `[ocr] 引擎=${res.engine} 耗时=${Date.now() - started}ms 字数=${res.text.length}`
      );
      return res;
    }
    // 识别为空（图上没有文字），直接返回空，不必降级
    return res;
  } catch (err) {
    console.warn('[ocr] Vision 失败，降级到 Tesseract:', err.message);
  }

  // 降级
  const res = await recognizeByTesseract(imagePath);
  console.log(
    `[ocr] 引擎=${res.engine} 耗时=${Date.now() - started}ms 字数=${res.text.length}`
  );
  return res;
}

/**
 * 带坐标框的识别（放大镜模式专用）。
 * 与 recognize() 区别：返回里带 blocks（每行文字 + 像素坐标框），
 * 镜片渲染据此把译文画到原文所在的位置。引擎切换对调用方透明。
 * @param {string} imagePath png 路径
 * @returns {Promise<{text:string, blocks:Array<{text:string,bbox:{x,y,width,height}}>, engine:string, confidence:number}>}
 */
async function recognizeWithBoxes(imagePath) {
  const started = Date.now();

  try {
    const res = await recognizeByVision(imagePath);
    if (res.text) {
      console.log(
        `[ocr:box] 引擎=${res.engine} 行数=${res.blocks.length} 耗时=${Date.now() - started}ms`
      );
      return res;
    }
    // Vision 返回空 → 直接返回空，【故意不降级 Tesseract】。
    // 理由：镜片是 ~9fps 的实时循环，而 Tesseract 单次识别要数秒（CPU 密集），
    // 首次还会下载 40MB 语言包。只要用户把镜片移到空白处就会触发，
    // 立刻卡死整个循环。这里返回空由调用方提示「未识别到文字」，
    // 比卡死体验好得多。Tesseract 仅在 Vision 真正不可用（抛错）时兜底。
    return res;
  } catch (err) {
    console.warn('[ocr:box] Vision 不可用，降级到 Tesseract:', err.message);
  }

  const res = await recognizeByTesseract(imagePath);
  console.log(
    `[ocr:box] 引擎=${res.engine} 行数=${res.blocks.length} 耗时=${Date.now() - started}ms`
  );
  return res;
}

/**
 * OCR 结果清洗
 * Tesseract 对中文常会在字之间插空格，这里做一次规整；
 * 同时把断行合并成通顺的段落，交给翻译模型效果更好。
 * （Vision 输出已经比较干净，这段清洗对它基本是幂等的。）
 */
function cleanText(raw) {
  if (!raw) return '';

  return raw
    // 去掉中文字符之间被误插入的空格
    .replace(/([\u4e00-\u9fa5]) +(?=[\u4e00-\u9fa5])/g, '$1')
    // 英文单词被换行拆开（形如 "trans-\nlate"）时接回去
    .replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2')
    // 中文行尾换行直接抹掉（中文不需要空格连接）
    .replace(/([\u4e00-\u9fa5，。！？；：、）】》])\n(?=[\u4e00-\u9fa5（【《])/g, '$1')
    // 剩下的换行统一成空格
    .replace(/\s*\n\s*/g, ' ')
    // 多个空格压成一个
    .replace(/ {2,}/g, ' ')
    .trim();
}

module.exports = { recognize, recognizeWithBoxes, groupWordsToLines, cleanText };
