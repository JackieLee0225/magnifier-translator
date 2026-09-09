'use strict';

/**
 * main.js —— Electron 主进程
 *
 * v1.4 重构：把「大窗口 + 框选翻译」整体换成「常驻悬浮球 + 控制面板」。
 *   - 悬浮球：屏幕上的小圆球，拖动可移动位置，单击弹出控制面板。
 *   - 控制面板：放大镜开关、镜片大小滑块、翻译 API 设置（DeepSeek Key / 方向）。
 *   - 框选翻译（overlay 拖框模式）已移除；保留并只保留「放大镜」模式。
 *   - 镜片大小（直径 90~320）的设置入口放进悬浮球控制面板。
 */

const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage,
  systemPreferences, dialog, shell
} = require('electron');
const path = require('path');
const fs = require('fs');

const { captureRegion, cleanupOldShots, probeScreencaptureAccess } = require('./src/capture');
const { recognize, recognizeWithBoxes, cleanText } = require('./src/ocr');
const { translate } = require('./src/translate');
const paths = require('./src/paths');
const log = require('./src/logger');

const PRELOAD = path.join(__dirname, 'preload.js');
const BALL_HTML = paths.resource('ball.html');
const PANEL_HTML = paths.resource('panel.html');
const LENS_HTML = paths.resource('lens.html');
const TRAY_ICON = paths.resource('assets', 'trayIcon.png');

// ---------------------------------------------------------------- 镜片（放大镜模式）相关常量
const LENS_MARGIN = 14;         // 镜片外留白，给蓝色发光环用
const LENS_MIN_R = 45;          // 镜片半径下限（直径 90）
const LENS_MAX_R = 160;         // 镜片半径上限（直径 320）
// 单词 / 句子翻译的分界：半径落在 [MIN, MIN+(MAX-MIN)/3] 即「≤ 1/3 大小」时为逐词翻译
const LENS_WORD_R = LENS_MIN_R + (LENS_MAX_R - LENS_MIN_R) / 3; // ≈ 83.33（直径 ≈166.7）
// 镜片半径（逻辑点），可由用户在悬浮球控制面板里调节并持久化
let lensRadius = 75;
try {
  const _s = require('./src/config').loadSettings();
  if (_s && _s.lensRadius) {
    lensRadius = Math.min(LENS_MAX_R, Math.max(LENS_MIN_R, Number(_s.lensRadius) || 75));
  }
} catch {}
function lensD() { return lensRadius * 2; }
function lensWinSize() { return lensD() + LENS_MARGIN * 2; }
// 镜片 ≤ 1/3 大小时逐词翻译，否则整句翻译（对应悬浮球控制面板的三等分刻度）
function isWordMode() { return lensRadius <= LENS_WORD_R; }
const LENS_TICK_MS = 110;       // 鼠标跟随 + 截图刷新的节拍（约 9 帧/秒）
const LENS_MAX_FAILS = 3;        // 截图连续失败多少次就自动退出放大镜模式

// ---------------------------------------------------------------- 窗口
let ballWin = null;             // 悬浮球窗口
let panelWin = null;            // 控制面板窗口（点击悬浮球时显示）
let ballDragPos = null;         // 拖动悬浮球时的基准坐标

// ---------------------------------------------------------------- 放大镜模式状态
let magnifierOn = false;
let lensWin = null;
let lensTimer = null;
let lensReady = false;
let ocrRunning = false;
let lastOcrStart = 0;
let lensFailCount = 0;
let permissionDialogOpen = false;
let screenProbeResult = null;
let permissionOverride = false;
let magnifierStarting = false;

// 取图/识别循环状态（freeze-and-hold 模型）：
//   扫描态：实时放大画面，无译文。
//   停稳 → 冻结当前帧 + 启动 OCR/翻译（ocrBusy=true）。
//   翻译在途：始终显示冻结帧、绝不因鼠标移动而丢弃在途译文。
//   译完：译文驻留显示，直到鼠标明显离开冻结位置（>SETTLED_MOVE_THRESHOLD）才释放回扫描态。
// 关键修复：之前“移动即作废”会把每次 1~2.6s 才回来的译文在用户手抖/扫描时丢掉 → 永远不显示。
let lastCursor = null;         // 上一拍鼠标位置（判断当前拍是否停下）
let stableTicks = 0;           // 连续稳定（几乎不动）的 Tick 计数
let frozen = null;             // 冻结帧：{ image:dataURL, shot:path, cursor:{x,y} }
let ocrBusy = false;           // 当前冻结帧的 OCR/翻译是否进行中
const MOVE_THRESHOLD = 8;       // 像素：超过即视为当前拍在移动（用于清零稳定计数）
const SETTLED_MOVE_THRESHOLD = 55; // 像素：离开冻结位置超过该距离才视为换新目标
const SETTLE_TICKS = 1;        // 连续 N 拍几乎不动即冻结（1≈110ms，尽快触发翻译）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 悬浮球 + 控制面板

function createBallWindow() {
  const disp = screen.getPrimaryDisplay();
  const x = disp.bounds.x + disp.bounds.width - 90;
  const y = disp.bounds.y + 140;
  ballWin = new BrowserWindow({
    width: 60,
    height: 60,
    x: Math.round(x),
    y: Math.round(y),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
  ballWin.loadFile(BALL_HTML);
  ballWin.once('ready-to-show', () => {
    if (ballWin && !ballWin.isDestroyed()) ballWin.show();
  });
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: 300,
    height: 470,
    transparent: false,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
  panelWin.loadFile(PANEL_HTML);
  // 点击面板之外让它自动收起，像系统弹层一样
  panelWin.on('blur', () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
  });
}

/** 在悬浮球旁边弹出控制面板 */
function openPanel() {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  if (!panelWin || panelWin.isDestroyed()) return;

  const ballPos = ballWin && !ballWin.isDestroyed() ? ballWin.getPosition() : [100, 100];
  const ballSize = ballWin && !ballWin.isDestroyed() ? ballWin.getSize() : [60, 60];
  const disp = screen.getDisplayNearestPoint({ x: ballPos[0] + ballSize[0] / 2, y: ballPos[1] + ballSize[1] / 2 });

  const pw = 300, ph = 470;
  let px = ballPos[0] + ballSize[0] + 12;
  let py = ballPos[1];
  if (px + pw > disp.bounds.x + disp.bounds.width) px = ballPos[0] - pw - 12; // 右侧放不下就翻到左侧
  if (px < disp.bounds.x) px = disp.bounds.x + 8;
  if (py + ph > disp.bounds.y + disp.bounds.height) py = disp.bounds.y + disp.bounds.height - ph - 8;
  if (py < disp.bounds.y) py = disp.bounds.y + 8;

  panelWin.setPosition(Math.round(px), Math.round(py));
  panelWin.show();
  panelWin.focus();
  broadcastState();
}

/** 把放大镜开关 / 镜片大小 / 翻译粒度推给悬浮球与控制面板，保持 UI 同步 */
function broadcastState() {
  const payload = { magnifierOn, lensDiameter: lensD(), wordMode: isWordMode() };
  if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('ball-state', payload);
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel-state', payload);
}

/** 按直径（像素）设置镜片大小，并持久化；放大镜运行时实时重建 */
function setLensDiameter(d) {
  const r = Math.min(LENS_MAX_R, Math.max(LENS_MIN_R, Math.round(Number(d) / 2)));
  if (r === lensRadius) return;
  adjustLens(r - lensRadius);
}

// ---------------------------------------------------------------- 托盘 + 快捷键

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  if (icon.isEmpty()) {
    console.warn('[main] 托盘图标加载失败，跳过托盘:', TRAY_ICON);
    return;
  }
  icon.setTemplateImage(true);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: '🔍 放大镜模式', click: () => toggleMagnifier() },
    { label: '⚙ 设置', click: () => openPanel() },
    {
      label: '显示悬浮球',
      click: () => { if (ballWin && !ballWin.isDestroyed()) { ballWin.show(); ballWin.focus(); } }
    },
    { type: 'separator' },
    {
      label: '📄 打开日志',
      click: () => shell.showItemInFolder(log.logPath())
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);

  tray.setToolTip('放大镜翻译器');
  tray.setContextMenu(contextMenu);
  // 左键点击：确保悬浮球可见
  tray.on('click', () => {
    if (ballWin && !ballWin.isDestroyed()) { ballWin.show(); ballWin.focus(); }
  });
}

let tray = null;

function registerShortcuts() {
  registerLensShortcut();
}

function registerLensShortcut() {
  const candidates = [
    'Control+`',
    'Control+Backquote',
    'CommandOrControl+Backquote',
    'Control+Oem3',
    'Control+Shift+L'
  ];
  for (const acc of candidates) {
    try {
      const ok = globalShortcut.register(acc, () => toggleMagnifier());
      if (ok) {
        console.log('[main] 放大镜快捷键已注册:', acc);
        return acc;
      }
      console.warn('[main] 放大镜快捷键被占用，尝试下一个:', acc);
    } catch (e) {
      console.warn('[main] 放大镜快捷键格式不支持，跳过:', acc, e.message);
    }
  }
  console.warn('[main] 放大镜快捷键全部注册失败，可用托盘菜单「放大镜模式」进入');
  return null;
}

// ---------------------------------------------------------------- 放大镜模式

function hasScreenPermission() {
  if (permissionOverride) return true;
  if (screenProbeResult === true) return true;
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted';
  } catch (err) {
    console.warn('[perm] 读取屏幕录制权限状态失败:', err.message);
    return true;
  }
}

async function probeScreenCapture() {
  if (screenProbeResult !== null) return screenProbeResult;
  screenProbeResult = await probeScreencaptureAccess();
  if (screenProbeResult) {
    log.info('[perm] 实测截图成功 → 屏幕录制权限可用（API 状态属误报，以实测为准）');
  } else {
    log.warn('[perm] 实测截图失败 → 确认无屏幕录制权限');
  }
  return screenProbeResult;
}

async function ensureScreenPermission() {
  if (permissionOverride) return true;
  const apiStatus = (() => {
    try {
      return systemPreferences.getMediaAccessStatus('screen');
    } catch {
      return 'unknown';
    }
  })();
  if (apiStatus === 'granted') return true;

  log.warn(`[perm] API 报告权限状态=${apiStatus}，改用实测截图复核`);
  const reallyOk = await probeScreenCapture();
  if (reallyOk) return true;

  await promptScreenPermission();
  return permissionOverride;
}

async function promptScreenPermission() {
  if (permissionDialogOpen) return;
  permissionDialogOpen = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '需要「屏幕录制」权限',
      message: '放大镜模式需要屏幕录制权限才能识别文字',
      detail:
        '请在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选本应用。\n\n' +
        '若列表里已经勾上了还是提示没权限：把本应用那条记录用「－」删掉，\n' +
        '重新打开本应用授权一次即可（应用每次更新签名都会变，旧授权会失效）。\n\n' +
        '注意：授权后必须【完全退出本应用再重新打开】，权限才会对新进程生效。',
      buttons: ['打开系统设置', '仍要继续', '稍后再说'],
      defaultId: 0,
      cancelId: 2
    });
    if (response === 0) {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      );
    } else if (response === 1) {
      permissionOverride = true;
      screenProbeResult = null;
      log.warn('[perm] 用户选择「仍要继续」，本次运行跳过权限门禁');
    }
  } catch (err) {
    console.warn('[perm] 弹出权限引导框失败:', err.message);
  } finally {
    permissionDialogOpen = false;
  }
}

function createLensWindow() {
  const win = new BrowserWindow({
    width: lensWinSize(),
    height: lensWinSize(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  win.loadFile(LENS_HTML);

  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => {
    log.error('[lens] 镜片页面加载失败 code=', code, 'desc=', desc, 'url=', url);
  });
  wc.on('render-process-gone', (_e, details) => {
    log.error('[lens] 镜片渲染进程退出 reason=', details.reason, 'exitCode=', details.exitCode);
  });
  wc.on('console-message', (_e, level, message, line, source) => {
    log.info(`[lens-renderer] L${level} ${message} (${source}:${line})`);
  });

  return win;
}

function positionLens(cursor) {
  const x = Math.round(cursor.x - lensWinSize() / 2);
  const y = Math.round(cursor.y - lensWinSize() / 2);
  lensWin.setPosition(x, y);
}

function regionUnder(cursor) {
  const disp = screen.getDisplayNearestPoint(cursor);
  const minX = disp.bounds.x;
  const minY = disp.bounds.y;
  const maxX = disp.bounds.x + disp.bounds.width - lensD();
  const maxY = disp.bounds.y + disp.bounds.height - lensD();

  let x = cursor.x - lensRadius;
  let y = cursor.y - lensRadius;
  x = Math.max(minX, Math.min(x, maxX));
  y = Math.max(minY, Math.min(y, maxY));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: lensD(),
    height: lensD()
  };
}

function toggleMagnifier() {
  if (magnifierOn) {
    stopMagnifier();
  } else {
    startMagnifier().catch((err) => {
      log.error('[lens] 进入放大镜模式失败:', err.message);
      magnifierStarting = false;
    });
  }
}

async function startMagnifier() {
  if (magnifierOn || magnifierStarting) return;
  magnifierStarting = true;

  try {
    const allowed = await ensureScreenPermission();
    if (!allowed) {
      log.warn('[lens] 缺少屏幕录制权限（API 与实测均失败），已阻止进入放大镜模式');
      return;
    }
  } finally {
    magnifierStarting = false;
  }
  log.info('[lens] 进入放大镜模式');

  magnifierOn = true;
  lensReady = false;
  ocrRunning = false;
  lastOcrStart = 0;
  lensFailCount = 0;
  lastCursor = null;
  stableTicks = 0;
  frozen = null;
  ocrBusy = false;

  lensWin = createLensWindow();
  lensWin.once('ready-to-show', () => {
    if (lensWin && !lensWin.isDestroyed()) {
      lensWin.show();
      lensWin.setOpacity(1);
    }
  });
  broadcastState(); // 通知悬浮球变绿
}

function stopMagnifier() {
  if (!magnifierOn) return;
  magnifierOn = false;
  if (lensTimer) clearTimeout(lensTimer);
  lensTimer = null;
  ocrRunning = false;
  lastCursor = null;
  stableTicks = 0;
  frozen = null;
  ocrBusy = false;
  if (lensWin && !lensWin.isDestroyed()) lensWin.destroy();
  lensWin = null;
  log.info('[lens] 已退出放大镜模式');
  broadcastState(); // 通知悬浮球恢复蓝色
}

function adjustLens(delta) {
  const next = Math.min(LENS_MAX_R, Math.max(LENS_MIN_R, lensRadius + delta));
  if (next === lensRadius) return;
  lensRadius = next;
  try {
    require('./src/config').saveSettings({ lensRadius });
  } catch {}
  log.info(`[lens] 镜片半径调整为 ${lensRadius}px（直径 ${lensD()}px）`);
  if (magnifierOn) {
    stopMagnifier();
    startMagnifier().catch((err) =>
      log.error('[lens] 重建镜片失败:', err.message)
    );
  }
}

function scheduleLensTick() {
  if (!magnifierOn) return;
  lensTimer = setTimeout(lensTick, LENS_TICK_MS);
}

/** 把截图文件读成 dataURL（供镜片渲染进程直接绘制） */
async function shotToDataURL(shot) {
  const buf = await fs.promises.readFile(shot);
  return 'data:image/png;base64,' + buf.toString('base64');
}

/** 截图失败的统一处理：累计失败次数，超限则退出放大镜模式并引导权限 */
function handleCaptureError(err) {
  lensFailCount++;
  screenProbeResult = null;
  log.warn(`[lens] 截图失败(${lensFailCount}/${LENS_MAX_FAILS}):`, err.message);
  if (lensFailCount >= LENS_MAX_FAILS) {
    const noPerm = !hasScreenPermission();
    stopMagnifier();
    if (noPerm) {
      promptScreenPermission();
    } else {
      dialog.showMessageBox({
        type: 'error',
        title: '放大镜已退出',
        message: '连续截图失败，已自动退出放大镜模式',
        detail: `最后一次错误：${err.message}`,
        buttons: ['知道了']
      }).catch(() => {});
    }
  }
}

async function lensTick() {
  if (!magnifierOn || !lensWin || lensWin.isDestroyed()) return;

  const cursor = screen.getCursorScreenPoint();
  positionLens(cursor);

  const moved =
    !lastCursor ||
    Math.hypot(cursor.x - lastCursor.x, cursor.y - lastCursor.y) > MOVE_THRESHOLD;
  if (moved) { lastCursor = { x: cursor.x, y: cursor.y }; stableTicks = 0; }
  else { stableTicks++; }

  // ---------------------------------------------------------------- 扫描态：无冻结帧
  if (!frozen) {
    if (moved) {
      // 移动中：实时放大画面，清掉任何残留译文覆盖层
      try {
        const shot = await captureRegion(regionUnder(cursor));
        const imageData = await shotToDataURL(shot);
        lensWin.webContents.send('lens-frame', { image: imageData });
        lensWin.webContents.send('lens-ocr', { blocks: [], translated: '', status: 'idle' });
        fs.promises.unlink(shot).catch(() => {});
      } catch (err) {
        handleCaptureError(err);
        scheduleLensTick();
        return;
      }
    } else if (stableTicks >= SETTLE_TICKS) {
      // 停稳：冻结当前帧，启动 OCR/翻译。翻译在途期间锁死，鼠标移动不再作废。
      try {
        const shot = await captureRegion(regionUnder(cursor));
        const imageData = await shotToDataURL(shot);
        frozen = { image: imageData, shot, cursor: { x: cursor.x, y: cursor.y } };
        ocrBusy = true;
        lensWin.webContents.send('lens-frame', { image: imageData });
        lensWin.webContents.send('lens-ocr', { blocks: [], translated: '', status: 'idle' });
        lensWin.webContents.send('lens-status', 'recognizing');
        if (!ocrRunning) startOcr(frozen.shot, cursor);
      } catch (err) {
        handleCaptureError(err);
        scheduleLensTick();
        return;
      }
    }
    scheduleLensTick();
    return;
  }

  // ---------------------------------------------------------------- 已冻结
  if (ocrBusy) {
    // 翻译在途：始终显示冻结帧（不重截、不因移动丢译文），等结果回来
    lensWin.webContents.send('lens-frame', { image: frozen.image });
    scheduleLensTick();
    return;
  }

  // 翻译已完成（held）：明显离开冻结位置 → 释放回扫描态；否则继续持有译文
  const away = Math.hypot(cursor.x - frozen.cursor.x, cursor.y - frozen.cursor.y) > SETTLED_MOVE_THRESHOLD;
  if (away) {
    frozen = null;
    lensWin.webContents.send('lens-ocr', { blocks: [], translated: '', status: 'idle' });
  } else {
    lensWin.webContents.send('lens-frame', { image: frozen.image });
  }
  scheduleLensTick();
}

async function startOcr(shot, cursor) {
  ocrRunning = true;
  lastOcrStart = Date.now();
  lensWin.webContents.send('lens-status', 'recognizing');

  let translated = '';
  let blocks = [];
  try {
    const t0 = Date.now();
    const ocr = await recognizeWithBoxes(shot);
    const ocrMs = Date.now() - t0;
    log.info(`[lens] OCR 引擎=${ocr.engine} 耗时=${ocrMs}ms 行数=${(ocr.blocks || []).length} 字数=${(ocr.text || '').length}`);

    if (!ocr.text) {
      // 没识别到文字：清掉覆盖层（不弹错误框）
      log.info('[lens] OCR 未识别到文字，清除覆盖层');
      if (lensWin && !lensWin.isDestroyed() && frozen && frozen.shot === shot) {
        lensWin.webContents.send('lens-ocr', { blocks: [], translated: '', status: 'idle' });
      }
      return;
    }

    blocks = ocr.blocks || [];
    const t1 = Date.now();
    try {
      const tr = await translate(ocr.text, {
        granularity: isWordMode() ? 'word' : 'sentence'
      });
      translated = tr.translated || '';
      log.info(`[lens] 翻译 provider=${tr.provider} 耗时=${Date.now() - t1}ms 译文长度=${translated.length}`);
    } catch (terr) {
      log.error('[lens] 翻译失败:', terr.message);
      if (lensWin && !lensWin.isDestroyed() && frozen && frozen.shot === shot) {
        const reason = /fetch failed|ENOTFOUND|ETIMEDOUT|network/i.test(terr.message)
          ? '翻译失败：网络不通'
          : `翻译失败：${terr.message.slice(0, 40)}`;
        lensWin.webContents.send('lens-status', { type: 'error', text: reason });
      }
      return;
    }

    if (!translated) {
      log.warn('[lens] 翻译返回空字符串');
      if (lensWin && !lensWin.isDestroyed() && frozen && frozen.shot === shot) {
        lensWin.webContents.send('lens-status', { type: 'error', text: '翻译返回为空' });
      }
      return;
    }

    // 译完即下发：只要该冻结帧仍有效（未被新冻结替换、未退出模式）就显示。
    // 不再因“鼠标移动”丢弃 —— 这是之前“永远不显示翻译”的根因。
    if (lensWin && !lensWin.isDestroyed() && frozen && frozen.shot === shot) {
      lensWin.webContents.send('lens-ocr', { blocks, translated, status: 'done' });
      log.info(`[lens] 译文已下发 blocks=${blocks.length} 长度=${translated.length}`);
    } else {
      log.info('[lens] 译文跳过（冻结帧已释放/模式已退出）');
    }
  } catch (err) {
    log.error('[lens] OCR 失败:', err.message);
    if (lensWin && !lensWin.isDestroyed() && frozen && frozen.shot === shot) {
      const reason = /ENOENT/.test(err.message) ? '截图丢失，请重试' : `识别失败：${err.message.slice(0, 40)}`;
      lensWin.webContents.send('lens-status', { type: 'error', text: reason });
    }
  } finally {
    ocrRunning = false;
    ocrBusy = false;
    fs.promises.unlink(shot).catch(() => {});
  }
}

// ---------------------------------------------------------------- IPC

// 镜片渲染进程就绪
ipcMain.on('lens-ready', () => {
  if (!magnifierOn || !lensWin || lensWin.isDestroyed()) return;
  lensReady = true;
  log.info('[lens] 镜片就绪，进入放大镜模式');
  lensWin.webContents.send('lens-config', { d: lensD(), margin: LENS_MARGIN });
  lensWin.webContents.send('lens-status', 'enter');
  scheduleLensTick();
});

// 保存设置（镜片大小直径 + API Key / 方向）
ipcMain.handle('save-settings', (_event, patch) => {
  const { saveSettings } = require('./src/translate');
  if (patch && patch.lensDiameter) setLensDiameter(patch.lensDiameter);
  const clean = { ...(patch || {}) };
  delete clean.lensDiameter;
  saveSettings(clean);
  return true;
});

ipcMain.handle('get-settings', () => {
  const { loadSettings } = require('./src/translate');
  const s = loadSettings();
  return {
    direction: s.direction || 'auto',
    provider: s.provider || 'auto',
    hasKey: Boolean(s.apiKey || s.apiKeyEnc),
    lensDiameter: lensD()
  };
});

ipcMain.handle('test-translate', async (_event, patch) => {
  const { translate } = require('./src/translate');
  const sample = 'Hello, this is a quick test.';
  try {
    return await translate(sample, {
      apiKey: patch && patch.apiKey,
      direction: (patch && patch.direction) || 'auto'
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- 悬浮球拖动 ----
ipcMain.on('ball-drag-start', () => {
  if (ballWin && !ballWin.isDestroyed()) ballDragPos = ballWin.getPosition();
});
ipcMain.on('ball-drag-move', (_e, { dx, dy }) => {
  if (!ballWin || ballWin.isDestroyed() || !ballDragPos) return;
  const nx = ballDragPos[0] + dx;
  const ny = ballDragPos[1] + dy;
  ballWin.setPosition(Math.round(nx), Math.round(ny));
  ballDragPos = [nx, ny];
});
ipcMain.on('ball-drag-end', () => { ballDragPos = null; });
ipcMain.on('ball-open-panel', () => openPanel());

// ---- 控制面板 ----
ipcMain.on('panel-hide', () => {
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
});
ipcMain.on('panel-request-state', () => {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('panel-state', { magnifierOn, lensDiameter: lensD(), wordMode: isWordMode() });
  }
});
ipcMain.on('set-magnifier', (_e, on) => {
  if (on) startMagnifier().catch((err) => log.error('[lens] 进入失败:', err.message));
  else stopMagnifier();
});
ipcMain.on('set-lens-size', (_e, d) => setLensDiameter(d));

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ballWin && !ballWin.isDestroyed()) { ballWin.show(); ballWin.focus(); }
  });
}

app.whenReady().then(() => {
  log.banner(app.getVersion());
  log.info('[main] 日志文件:', log.logPath());
  createBallWindow();
  try {
    createTray();
  } catch (err) {
    console.warn('[main] 托盘创建失败:', err.message);
  }
  registerShortcuts();
  cleanupOldShots();

  app.on('activate', () => {
    if (ballWin && !ballWin.isDestroyed()) { ballWin.show(); ballWin.focus(); }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
