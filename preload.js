'use strict';

/**
 * preload.js —— 渲染进程与主进程之间的安全桥梁
 * 页面只能看到 contextBridge 白名单里的方法，拿不到 require / fs / process。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---------- 设置（API Key 等）----------
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  testTranslate: (patch) => ipcRenderer.invoke('test-translate', patch),

  // ---------- 悬浮球 ----------
  /** 通知主进程：开始拖动小球（记录基准坐标） */
  ballDragStart: () => ipcRenderer.send('ball-drag-start'),
  /** 拖动增量（全局坐标），主进程据此 setPosition */
  ballDragMove: (dx, dy) => ipcRenderer.send('ball-drag-move', { dx, dy }),
  ballDragEnd: () => ipcRenderer.send('ball-drag-end'),
  /** 单击小球 → 弹出控制面板 */
  ballOpenPanel: () => ipcRenderer.send('ball-open-panel'),
  /** 主进程推送放大镜开关状态，更新小球外观 */
  onBallState: (cb) => {
    ipcRenderer.removeAllListeners('ball-state');
    ipcRenderer.on('ball-state', (_e, st) => cb(st));
  },

  // ---------- 控制面板 ----------
  /** 开 / 关放大镜模式 */
  setMagnifier: (on) => ipcRenderer.send('set-magnifier', on),
  /** 设置镜片直径（像素） */
  setLensSize: (d) => ipcRenderer.send('set-lens-size', d),
  /** 收起面板 */
  hidePanel: () => ipcRenderer.send('panel-hide'),
  /** 主动请求一次最新状态（打开面板时兜底） */
  panelRequestState: () => ipcRenderer.send('panel-request-state'),
  /** 主进程推送面板状态（开关 / 镜片大小） */
  onPanelState: (cb) => {
    ipcRenderer.removeAllListeners('panel-state');
    ipcRenderer.on('panel-state', (_e, st) => cb(st));
  },

  // ---------- 镜片（lens.html）用 ----------
  onLensFrame: (cb) => {
    ipcRenderer.removeAllListeners('lens-frame');
    ipcRenderer.on('lens-frame', (_event, payload) => cb(payload));
  },
  onLensOcr: (cb) => {
    ipcRenderer.removeAllListeners('lens-ocr');
    ipcRenderer.on('lens-ocr', (_event, payload) => cb(payload));
  },
  onLensStatus: (cb) => {
    ipcRenderer.removeAllListeners('lens-status');
    ipcRenderer.on('lens-status', (_event, status) => cb(status));
  },
  lensReady: () => ipcRenderer.send('lens-ready'),
  onLensConfig: (cb) => {
    ipcRenderer.removeAllListeners('lens-config');
    ipcRenderer.on('lens-config', (_event, cfg) => cb(cfg));
  }
});
