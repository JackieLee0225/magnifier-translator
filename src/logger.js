'use strict';

/**
 * logger.js —— 持久化文件日志
 *
 * 【为什么需要它】
 * 打包成 .app 之后，console.log 就消失了：从启动台双击打开的应用没有终端，
 * 用户看不到任何输出，开发者也拿不到现场。于是「镜片没出译文」这类问题
 * 只能靠猜——猜是 OCR 空、还是翻译超时、还是网络被拦。
 *
 * 把日志写进文件后，用户只要点一下托盘的「打开日志」，就能把真实的
 * 执行路径和失败原因交出来，排查从猜测变成读数据。
 *
 * 【设计取舍】
 *   - 写到 userData/logs/app.log，每个用户各自独立且必定可写
 *     （绝不能写到应用目录：打包后是只读的，而且 cwd 是 "/"）
 *   - 同步写入：日志量很小，但崩溃前的最后一条最有价值，不能丢在缓冲区里
 *   - 超过 1MB 自动轮转成 app.old.log，避免长期运行撑爆磁盘
 *   - 任何写失败都静默吞掉：日志是辅助设施，绝不能反过来把主流程搞崩
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_SIZE = 1024 * 1024; // 单个日志文件上限 1MB，超过就轮转

let logFilePath = null;

/** 解析日志文件路径（懒解析：首次写入时才创建目录） */
function getLogFile() {
  if (logFilePath) return logFilePath;
  try {
    const dir = paths.ensureDir(path.join(paths.userData(), 'logs'));
    logFilePath = path.join(dir, 'app.log');
  } catch {
    // userData 拿不到（极端情况）就退回临时目录，保证日志功能不至于完全失效
    logFilePath = path.join(require('os').tmpdir(), 'magnifier-translator.log');
  }
  return logFilePath;
}

/** 超过上限就把当前日志改名保留一份，重新开始写 */
function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_SIZE) {
      fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
    }
  } catch {
    /* 文件还不存在或改名失败，都不影响继续写 */
  }
}

/** 时间戳：本地时间，精确到毫秒，方便对齐"哪一帧慢了" */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 写一条日志
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {...any} args 任意参数，对象会被 JSON 化
 */
function write(level, ...args) {
  const text = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');

  const line = `[${stamp()}] [${level}] ${text}\n`;

  // 同时输出到控制台，开发期 npm start 仍能直接看到
  if (level === 'ERROR') console.error(line.trim());
  else if (level === 'WARN') console.warn(line.trim());
  else console.log(line.trim());

  try {
    const file = getLogFile();
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch {
    /* 日志写失败绝不能影响主流程 */
  }
}

const info = (...a) => write('INFO', ...a);
const warn = (...a) => write('WARN', ...a);
const error = (...a) => write('ERROR', ...a);

/** 供托盘菜单「打开日志」使用 */
function logPath() {
  return getLogFile();
}

/** 应用启动时记一条分隔线，方便区分不同次运行 */
function banner(version) {
  write('INFO', '='.repeat(56));
  write('INFO', `应用启动 v${version} | electron=${process.versions.electron} node=${process.versions.node}`);
}

module.exports = { info, warn, error, logPath, banner };
