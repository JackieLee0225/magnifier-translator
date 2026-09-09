'use strict';

/**
 * translate.js —— 翻译适配层
 *
 * 设计目标：调用方只管 translate(text)，引擎和密钥对它透明。
 *
 * 优先级：
 *   1. 配置了 DeepSeek API Key → 走 DeepSeek（质量最好、几乎免费）
 *   2. 没 Key 或 DeepSeek 报错 → 降级到免费 MyMemory 接口（联网即可用）
 *
 * 翻译方向（用户选了「自动判断」）：
 *   - 检测到中文 → 译成英文
 *   - 检测到其它（英文/日文等）→ 译成中文
 *   也支持 settings.direction = 'zh2en' | 'en2zh' 强制方向（留给 Step 3 的 UI 开关）
 *
 * 依赖：Node 22 内置 fetch，不装 axios。
 */

const { loadSettings, saveSettings } = require('./config');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const FREE_URL = 'https://api.mymemory.translated.net/get';

const LANG_NAMES = { zh: 'Chinese', en: 'English', ja: 'Japanese' };

/**
 * 译文缓存：相同原文（同粒度 / 同方向）直接命中，避免重复联网。
 * 让“再次把镜片停到同一处文字”时翻译秒回，也显著降低接口限流概率。
 */
const _trCache = new Map();
const _trCacheTTL = 5 * 60 * 1000; // 5 分钟
const _trCacheMax = 300;

function _trCacheKey(source, granularity, direction) {
  const norm = source.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${granularity}|${direction.from}>${direction.to}|${norm}`;
}
function _trCacheGet(key) {
  const e = _trCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > _trCacheTTL) { _trCache.delete(key); return null; }
  return e.v;
}
function _trCacheSet(key, v) {
  _trCache.set(key, { v, t: Date.now() });
  if (_trCache.size > _trCacheMax) {
    const first = _trCache.keys().next().value;
    if (first !== undefined) _trCache.delete(first);
  }
}

/**
 * 轻量语言检测（不引第三方库）。
 * 命中 CJK / 假名 / 谚文任一字符就判为中文，否则英文。
 * @param {string} text
 * @returns {'zh' | 'en'}
 */
function detectSourceLang(text) {
  if (/[一-鿿぀-ヿ가-힯]/.test(text)) return 'zh';
  return 'en';
}

/**
 * 解析翻译方向
 * @param {string} source 原文
 * @param {'auto'|'zh2en'|'en2zh'} [prefer] 用户偏好，'auto' 或不传则自动判断
 */
function resolveDirection(source, prefer) {
  if (prefer && prefer !== 'auto') {
    return prefer === 'zh2en'
      ? { from: 'zh', to: 'en' }
      : { from: 'en', to: 'zh' };
  }
  const from = detectSourceLang(source);
  return from === 'zh' ? { from: 'zh', to: 'en' } : { from: 'en', to: 'zh' };
}

/**
 * 构造 System 提示词。
 * @param {string} from 源语言
 * @param {string} to   目标语言
 * @param {'sentence'|'words'} [mode] 'words' = 逐词对照翻译
 */
function buildSystemPrompt(from, to, mode = 'sentence') {
  const f = LANG_NAMES[from] || from;
  const t = LANG_NAMES[to] || to;
  const head =
    `You are a professional translator. Translate the user's text from ${f} to ${t}. ` +
    `Output ONLY the translation, with no extra explanation, no quotes, and no commentary. `;
  if (mode === 'words') {
    return (
      head +
      `Translate each word individually and independently. ` +
      `Output the translated words in the SAME order as the input, separated by a single space. ` +
      `Do NOT merge them into a flowing sentence. ` +
      `If a word is already in the target language or has no direct equivalent, ` +
      `give its basic meaning or a transliteration. ` +
      `Keep a strict one-to-one correspondence with the input words.`
    );
  }
  return head + `Preserve line breaks and paragraph structure where reasonable.`;
}

/**
 * 执行一次翻译（不关心粒度）。
 * 有 Key 走 DeepSeek，失败降级免费接口。返回 { translated, provider }。
 * @param {'sentence'|'words'} [mode]
 */
async function doTranslate(source, direction, apiKey, mode = 'sentence') {
  if (apiKey) {
    try {
      const translated = await translateWithDeepSeek(source, direction.from, direction.to, apiKey, mode);
      return { translated, provider: 'deepseek' };
    } catch (err) {
      console.warn('[translate] DeepSeek 失败，降级到免费接口:', err.message);
    }
  }
  const translated = await translateWithFree(source, direction.from, direction.to);
  return { translated, provider: 'free' };
}

/** DeepSeek 翻译（主引擎） */
async function translateWithDeepSeek(source, from, to, apiKey, mode = 'sentence') {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: buildSystemPrompt(from, to, mode) },
        { role: 'user', content: source }
      ],
      temperature: 0.3,
      stream: false
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 140)}`);
  }

  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('DeepSeek 返回为空');
  return out;
}

/** 免费兜底翻译（MyMemory，无需 Key，但有每日字数限制） */
async function translateWithFree(source, from, to) {
  const pair = `${from}|${to}`;
  const url = `${FREE_URL}?q=${encodeURIComponent(source)}&langpair=${encodeURIComponent(pair)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MyMemory ${res.status}`);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out) throw new Error('MyMemory 返回为空');
  return out;
}

/**
 * 翻译入口
 * @param {string} source 原文
 * @param {{direction?: 'auto'|'zh2en'|'en2zh', apiKey?: string,
 *          granularity?: 'word'|'sentence'}} [opts]
 *   - granularity='word'   → 逐词翻译（镜片 ≤ 1/3 大小时用，见 main.js 的 isWordMode）
 *   - granularity='sentence'（默认）→ 整句翻译
 * @returns {Promise<{ok:boolean, translated?:string, provider?:string,
 *                     direction?:{from:string,to:string}, error?:string}>}
 */
async function translate(source, opts = {}) {
  const settings = loadSettings();
  const direction = resolveDirection(source, opts.direction || settings.direction || 'auto');
  const apiKey = opts.apiKey || settings.apiKey;
  const granularity = opts.granularity || 'sentence';

  // 逐词 / 整句 都只发「一次」请求：
  //   - 逐词模式用「逐词对照」提示词，让模型一次返回空格分隔的单词译文，
  //     避免逐词多次调用触发 DeepSeek / 免费接口限流（之前多次调用正是间歇性“不翻译”的根因）。
  //   - 免费接口（MyMemory）不支持逐词对照，逐词模式下会退化为整句翻译，属可接受的兜底。
  const mode = granularity === 'word' ? 'words' : 'sentence';

  // 命中缓存直接返回（provider 标 cache，便于日志区分）
  const key = _trCacheKey(source, granularity, direction);
  const cached = _trCacheGet(key);
  if (cached) return { ok: true, translated: cached, provider: 'cache', direction };

  const r = await doTranslate(source, direction, apiKey, mode);
  _trCacheSet(key, r.translated);
  return { ok: true, translated: r.translated, provider: r.provider, direction };
}

// 暴露给 UI / 单测
module.exports = {
  translate,
  detectSourceLang,
  resolveDirection,
  buildSystemPrompt,
  saveSettings,
  loadSettings
};
