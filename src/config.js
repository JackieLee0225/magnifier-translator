'use strict';

/**
 * config.js —— 设置持久化（API Key 加密存储）
 *
 * 为什么单独一个文件：
 *   Step 2 要引入 DeepSeek 的 API Key，明文落盘等于把密钥白送别人。
 *   Electron 自带 safeStorage，用系统钥匙串级别的加密把 Key 存到磁盘；
 *   文件里只留密文（base64），明文只在内存里出现。
 *
 * 为什么懒加载 require('electron')：
 *   这样本模块在纯 Node 下也能被 import（用于写单测），只有在真正读写
 *   密钥时才去取 electron 的 app / safeStorage。
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

/**
 * 设置文件路径。
 * 交给 paths 层解析（app.getPath('userData')，并保证目录已创建）——
 * 首次运行时 userData 目录不一定存在，直接 writeFileSync 会 ENOENT。
 */
function settingsFile() {
  return paths.settingsFile();
}

/**
 * 取 safeStorage，并确认加密真的可用。
 * 不能假定它一定能用：钥匙串被锁、系统降级、或用户拒绝授权时，
 * encryptString 会直接抛异常。发布给别人用时这类环境差异必须扛住。
 */
function getSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch {
    /* 纯 Node 环境或 electron 未就绪 */
  }
  return null;
}

/** 读取全部设置；apiKey 会被就地解密成明文返回（仅内存中） */
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj.apiKeyEnc) {
      try {
        const safeStorage = getSafeStorage();
        if (!safeStorage) throw new Error('系统加密不可用');
        obj.apiKey = safeStorage
          .decryptString(Buffer.from(obj.apiKeyEnc, 'base64'))
          .toString('utf8');
      } catch (e) {
        // 解密失败（换机器、重装系统、钥匙串被锁）就当作没有 Key，
        // 让翻译走免费兜底，而不是让整个应用起不来
        console.warn('[config] 解密 API Key 失败:', e.message);
        obj.apiKey = '';
      }
    }
    return obj;
  } catch {
    return {};
  }
}

/**
 * 保存设置。
 * @param {object} patch 要覆盖的字段；含 apiKey 时会加密后落盘，不写明文。
 */
function saveSettings(patch = {}) {
  const cur = loadSettings();
  const next = { ...cur, ...patch };

  if (patch.apiKey) {
    const safeStorage = getSafeStorage();
    if (safeStorage) {
      const enc = safeStorage.encryptString(patch.apiKey);
      next.apiKeyEnc = enc.toString('base64');
    } else {
      // 加密不可用时宁可不存，也绝不把明文 Key 落盘
      console.warn('[config] 系统加密不可用，本次不保存 API Key');
    }
    delete next.apiKey; // 无论如何，明文都不写进文件
  }

  const file = settingsFile();
  paths.ensureDir(path.dirname(file)); // 首次运行目录可能还不存在
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { loadSettings, saveSettings };
