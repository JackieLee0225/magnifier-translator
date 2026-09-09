'use strict';

/**
 * paths.js —— 全应用统一的路径解析层
 *
 * 【为什么要单独抽这一层】
 * 写死路径在自己机器上跑得好好的，一旦打包成 .app 发给别人就会崩，原因有三：
 *
 *   1. 从 Finder / 启动台打开的 App，process.cwd() 是 "/"（根目录，只读）。
 *      任何"默认往当前目录写文件"的库（比如 tesseract.js 缓存语言包）都会
 *      直接 EACCES 权限拒绝——而在终端 `npm start` 时 cwd 是项目目录，
 *      可写，所以这个 bug 在开发期 100% 复现不出来。
 *
 *   2. 源码被打进 app.asar（一个虚拟只读归档），__dirname 会指向 asar 内部。
 *      asar 里的文件不能被 execFile 执行，原生二进制必须放在 asar 外面，
 *      通过 process.resourcesPath 定位。
 *
 *   3. 别人的用户名、磁盘位置、语言环境都和你不同，任何 /Users/yourname/... 这类
 *      绝对路径都不成立。
 *
 * 【规则】
 *   - 运行时要「写」的目录  → 一律走 Electron app.getPath()
 *   - 随包分发的「只读」资源 → 一律基于 app.getAppPath() / process.resourcesPath
 *   - 系统自带命令          → 探测存在性，不假定唯一路径
 *
 * 【纯 Node 兼容】
 *   本模块顶层不 require('electron')，拿不到 app 时退回 os.tmpdir()，
 *   这样 config / translate / ocr 仍可脱离 Electron 跑单元测试。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 应用标识：脱离 Electron 时用它拼兜底目录，避免污染 /tmp 根目录 */
const APP_SLUG = 'magnifier-translator';

/**
 * 懒取 electron.app。
 * 注意：在纯 Node 下 require('electron') 返回的是二进制路径字符串，
 * 所以必须检查 getPath 是不是函数，不能只判断真值。
 */
function getApp() {
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

/** 是否运行在打包后的 .app 里（开发期为 false） */
function isPackaged() {
  const app = getApp();
  return Boolean(app && app.isPackaged);
}

/** mkdir -p；失败不抛，让调用方在真正写文件时报出更有意义的错误 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或无权限，交给后续写操作报错 */
  }
  return dir;
}

/** 应用代码根目录：开发期 = 项目根，打包后 = app.asar 内部根 */
function appRoot() {
  const app = getApp();
  if (app) return app.getAppPath();
  return path.join(__dirname, '..');
}

/**
 * 随包分发的只读资源（index.html / overlay.html / assets 等，都在 asar 内）
 * @param {...string} segments 相对应用根目录的路径片段
 */
function resource(...segments) {
  return path.join(appRoot(), ...segments);
}

/**
 * 用户数据目录（设置、缓存）。
 * macOS 上是 ~/Library/Application Support/<产品名>/，每个用户各自独立。
 * @param {...string} segments
 */
function userData(...segments) {
  const app = getApp();
  const base = app ? app.getPath('userData') : path.join(os.tmpdir(), APP_SLUG);
  ensureDir(base);
  return segments.length ? path.join(base, ...segments) : base;
}

/** 设置文件（含加密后的 API Key） */
function settingsFile() {
  return userData('settings.json');
}

/**
 * Tesseract 语言包缓存目录。
 * 这是最关键的一处：tesseract.js 默认 cachePath 是 '.'（当前工作目录），
 * 打包后 cwd = "/"，写 chi_sim.traineddata 必然失败。必须显式指到这里。
 */
function tessdataDir() {
  return ensureDir(userData('tessdata'));
}

/**
 * 截图暂存目录。
 * 放在系统临时目录下的专属子目录里，而不是直接扔进 temp 根目录——
 * 这样清理时只需扫自己这一个文件夹，不用遍历整个 /var/folders/...
 */
function shotsDir() {
  const app = getApp();
  const base = app ? app.getPath('temp') : os.tmpdir();
  return ensureDir(path.join(base, APP_SLUG, 'shots'));
}

/**
 * Apple Vision OCR 原生二进制。
 * 打包后由 electron-builder 的 extraResources 放到 Resources/bin/（asar 外，
 * 因为 asar 内的文件无法执行）；开发期在项目 build/ 下。
 */
function visionBinary() {
  const candidates = [];

  // 打包后优先：<App>.app/Contents/Resources/bin/vision-ocr
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', 'vision-ocr'));
  }
  // 开发期：<项目根>/build/vision-ocr
  candidates.push(path.join(appRoot(), 'build', 'vision-ocr'));

  // 打包后 appRoot() 指向 asar，上面那条不会命中，顺序上让 resourcesPath 先走；
  // 开发期 resourcesPath 指向 Electron.app 自己的 Resources，那儿不会有我们的
  // 二进制，所以也不会误命中。两种环境都靠 existsSync 兜住。
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略探测失败，继续试下一个 */
    }
  }

  // 都找不到就返回首选路径，让 execFile 抛 ENOENT，触发 Tesseract 降级
  return candidates[0];
}

/**
 * macOS 自带的截图命令。
 * 不写死单一绝对路径：虽然 /usr/sbin/screencapture 在现行 macOS 上很稳定，
 * 但探测一遍成本极低，且最终能退回 PATH 查找。
 */
function screencaptureBin() {
  const candidates = ['/usr/sbin/screencapture', '/usr/bin/screencapture'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return 'screencapture'; // 交给 PATH 解析
}

module.exports = {
  APP_SLUG,
  isPackaged,
  ensureDir,
  appRoot,
  resource,
  userData,
  settingsFile,
  tessdataDir,
  shotsDir,
  visionBinary,
  screencaptureBin
};
