# 放大镜翻译器

macOS 屏幕取词翻译工具：**框选 → OCR → AI 翻译**，以及 **放大镜模式（实时覆盖翻译）**。

- OCR 用 macOS 原生 **Apple Vision**（本地、免费、无限次、约 200ms），Tesseract 作兜底
- 翻译用 **DeepSeek**（自动判断方向：中文→英文，外文→中文），无 Key 时自动降级到免费接口
- 全局快捷键 `Cmd+Shift+T`（框选翻译）、`Control+``（放大镜模式）、菜单栏托盘常驻
- **放大镜模式**：一个 150px 的圆形镜片跟随鼠标，实时把镜片下方的文字**识别并替换成译文**，
  像透过放大镜看到译文覆盖在原文位置，而不是弹窗

---

## 快速开始（开发模式）

```bash
cd ~/Projects/magnifier-translator
npm install              # 安装依赖
npm run build:ocr        # 编译 Apple Vision OCR 二进制（只需一次）
npm start                # 启动
```

首次框选时 macOS 会弹「屏幕录制」授权请求 → 允许 → **重启 App** 才生效。
（系统设置 → 隐私与安全性 → 屏幕录制）

## 打包 .dmg

```bash
# 若已存在 dist，先移走（不要用 rm，见下方「已知坑」）
mv dist /tmp/dist_old_$(date +%s) 2>/dev/null
npm run dist
```

产物：`dist/放大镜翻译器-<版本号>-arm64.dmg`（约 123MB，Apple Silicon）

### 关于代码签名

没有 Apple Developer ID 证书（¥688/年）时，electron-builder 会**跳过整个签名步骤** ——
后果不只是"没签名"，而是 bundle Identifier 退回成 `Electron`、entitlements 完全不写入、
`hardenedRuntime` 形同虚设。屏幕录制授权会记到错误对象上，重新构建后授权失效。

所以本项目挂了一个 `afterSign` 钩子 `build/adhoc-sign.js`，
按 framework → helper → 原生二进制 → 外层 .app 的顺序重签一遍，并绑定 entitlements。
签名后会自动 `codesign --verify` 自检，不通过就让构建失败。

#### ⚠️ 必做一次：创建固定签名证书

```bash
bash scripts/create-signing-cert.sh   # 只需跑一次
```

**不做会怎样**：钩子会回退到 ad-hoc 签名，而 ad-hoc 的 designated requirement 是
`identifier "…" and cdhash H"389779ef…"` —— 授权被死锁在一个精确的代码哈希上。
**改一行代码重新打包，cdhash 就变，「屏幕录制」授权立刻作废**，
表现为系统设置里明明勾着、应用却一直提示没权限，每发一版都要重新授权一次。

跑完脚本后 requirement 变成绑定证书：
`identifier "…" and certificate leaf = H"证书哈希"`，证书不换就一直有效。

首次换用新证书后仍需重新授权一次（签名主体变了）：

```bash
tccutil reset ScreenCapture com.lee.magnifiertranslator
```

然后打开应用授权、完全退出重开即可。此后重新打包不再需要重复这个流程。

打包完可以这样确认：

```bash
codesign -dv "dist/mac-arm64/放大镜翻译器.app"          # 应显示 Identifier=com.lee.magnifiertranslator
codesign -d --entitlements - "dist/mac-arm64/放大镜翻译器.app"   # 应列出 4 条权限
```

ad-hoc 签名**无法通过公证（notarization）**，别人下载后首次打开需要：
右键 → 打开，或到「系统设置 → 隐私与安全性」点「仍要打开」。自用完全没问题。
要做公开分发才需要买证书，届时把 `CSC_LINK` / `CSC_KEY_PASSWORD` 配上即可，钩子会自动让位。

---

## 使用方式

| 操作 | 方式 |
|---|---|
| 触发框选 | `Cmd+Shift+T`，或点面板「框选翻译」，或托盘菜单 |
| **进入 / 退出放大镜模式** | **`Control+ `` （数字 1 左边那个键），再按一次退出** |
| 取消框选 | `Esc` |
| 复制原文/译文 | 各卡片右上角复制按钮 |
| 移动窗口 | 拖拽面板顶部区域 |
| 隐藏/显示 | 点击菜单栏放大镜图标 |

### 放大镜模式怎么用

1. 按 `Control+ `` 进入模式：鼠标处出现一个蓝色发光的圆形镜片，边缘会闪一下表示已开启。
2. 移动鼠标，镜片跟着走；镜片下方的文字会被实时识别并**替换成译文**画在原文位置。
3. 识别中镜片中央显示 🔍；识别完成边缘绿色闪一下。
4. 再按一次 `Control+ `` 退出，镜片消失，恢复正常鼠标。

镜片是**点击穿透**的，不挡你操作；截图只取镜片下 150×150 区域，OCR 节流 200ms、
并对相同区域做位置缓存，移动鼠标时不会无谓地重复识别。

> 说明：镜片内译文是「1:1 覆盖」在原文位置（不是放大），所以对齐最精确；
> 译文比原文长时会自动缩小字号挤进原位置。多行识别结果与译文行数不一致时，
> 会整体覆盖文字区并把译文居中铺进去。

### 配置 DeepSeek API Key

面板右上角 ⚙️ → 填入 `sk-` 开头的 Key → 保存。

Key 用 Electron `safeStorage`（系统钥匙串级加密）存储，落盘只有密文，位置：
`~/Library/Application Support/放大镜翻译器/settings.json`

**不填 Key 也能用** —— 会自动走免费 MyMemory 接口，只是质量和额度有限。

---

## 项目结构

```
magnifier-translator/
├── main.js              # 主进程：窗口、IPC、托盘、快捷键
├── preload.js           # 上下文隔离桥（页面通过 window.api 通信）
├── index.html           # 主面板 UI（原文/译文分区卡片）
├── overlay.html         # 全屏框选覆盖层
├── lens.html            # ★ 放大镜模式镜片 UI（canvas 圆形裁剪 + 译文覆盖）
├── src/
│   ├── paths.js         # ★ 全应用路径解析（app.getPath 收口，见下方「路径规范」）
│   ├── capture.js       # 截图：screencapture -R 主方案 + desktopCapturer 兜底
│   ├── ocr.js           # OCR：Apple Vision 主引擎 + Tesseract 兜底
│   ├── translate.js     # 翻译：DeepSeek 主引擎 + MyMemory 兜底，自动判方向
│   └── config.js        # 设置持久化，API Key 加密存储
├── native/ocr.swift     # Vision OCR 源码（输出 JSON：文本+置信度+坐标框）
├── build/vision-ocr     # 编译产物（132KB）
└── assets/              # 托盘图标、App 图标
```

## 架构要点

**截图为什么用 `screencapture -R` 而不是 `desktopCapturer`**
`screencapture` 接受全局坐标，直接对应框选区域，省掉多屏缩放换算，也不受 Retina 像素比影响。`desktopCapturer` 仅作兜底。

**OCR 降级链**
`build/vision-ocr`（开发期）或 `Resources/bin/vision-ocr`（打包后）→ 找不到或执行失败 → 自动切 Tesseract.js。降级会在控制台打日志。

**翻译降级链**
有 Key → DeepSeek；无 Key / 请求失败 → MyMemory 免费接口。两条链路都验证过。

**放大镜模式怎么把译文"贴"回原文位置**
OCR（Vision / Tesseract）都会返回每行文字的**像素坐标框**（`blocks[].bbox`）。
主进程每拍：读光标 → 把镜片窗口移到光标处 → 截镜片下方 150×150 → 读图发给镜片渲染进程 →
按需跑 OCR+翻译 → 把坐标框 + 译文推给 `lens.html`。`lens.html` 用离屏 canvas 取每块文字的平均
背景色当覆盖色，再把译文画在对应坐标框上（字号随行高、按宽度收缩，颜色按背景明暗取反），
实现"透过镜片看到译文覆盖原文"。

> 关键防递归细节：截图前先 `setOpacity(0)` 把镜片藏起来，否则镜片自己会被拍进下一帧，
> OCR 会把上一帧的译文当原文再翻一遍，越翻越乱。截完再 `setOpacity(1)`。

---

## 路径规范（发布给别人用的前提）

所有路径统一由 `src/paths.js` 解析，**业务代码里不允许出现写死的绝对路径、相对路径或 cwd 依赖**。

| 用途 | 解析方式 | 实际位置 |
|---|---|---|
| 只读资源（html/图标） | `paths.resource()` → `app.getAppPath()` | app.asar 内 |
| 设置文件 | `paths.settingsFile()` → `app.getPath('userData')` | `~/Library/Application Support/放大镜翻译器/` |
| Tesseract 语言包缓存 | `paths.tessdataDir()` | 同上 `/tessdata/` |
| 截图暂存 | `paths.shotsDir()` → `app.getPath('temp')` | 系统临时目录下专属子目录 |
| Vision 原生二进制 | `paths.visionBinary()` | 打包后 `Resources/bin/`，开发期 `build/` |
| 系统截图命令 | `paths.screencaptureBin()` | 探测 `/usr/sbin` → `/usr/bin` → PATH |

**为什么必须这样做**：从 Finder / 启动台打开的 App，`process.cwd()` 是 `/`（只读）。
任何默认"往当前目录写文件"的库都会 EACCES 崩溃，而终端 `npm start` 时 cwd 是项目目录、
可写，所以这类 bug 在开发期 100% 复现不出来，只有别人装上才暴露。

`paths.js` 顶层不 `require('electron')`，拿不到 `app` 时退回 `os.tmpdir()`，
因此 `config` / `translate` / `ocr` 仍可脱离 Electron 跑单元测试。

---

## 已知坑（踩过的）

1. **打包前不要用 `rm -rf dist`** —— 某些环境的安全钩子会拦截批量删除导致 electron-builder 中途失败。用 `mv` 移走。
2. **`mac` 配置里不能写 `arch` 字段** —— electron-builder 26 的 schema 不认，架构只能通过命令行 `--arm64` 指定，否则报 `mac should be one of these: null`。
3. **`tesseract.js` 必须在 `dependencies`** —— 放 `devDependencies` 打包会被剔除，运行时报 `Cannot find module 'tesseract.js'`。
4. **改了 entitlements 后要重新授权屏幕录制** —— 签名变了，macOS 会把它当成新 App。
5. **tesseract.js 默认把语言包写进当前工作目录** —— 默认 `cachePath: '.'`。开发期 cwd 是
   项目目录所以看不出问题（会在项目根留下 `chi_sim.traineddata` / `eng.traineddata`），
   打包后 cwd 是 `/`，兜底 OCR 直接权限拒绝。必须显式传 `cachePath`。
6. **`safeStorage` 不保证可用** —— 钥匙串被锁或系统降级时 `encryptString()` 会抛异常。
   调用前先 `isEncryptionAvailable()`，加密不可用时宁可不存也别把明文 Key 落盘。
7. **托盘图标加载失败会让 App 起不来** —— `new Tray(空图)` 直接抛异常。图标只是辅助入口，
   要用 `icon.isEmpty()` 判一下再建。
8. **镜片防自拍要用 `setContentProtection(true)`，不要用透明度开关** —— 镜片若被拍进下一帧，
   OCR 会递归翻译自己的译文、越翻越乱。最初的做法是截图前 `setOpacity(0)`、截完 `setOpacity(1)`，
   但镜片循环每 110ms 跑一次，等于每秒把窗口闪 9 次，**肉眼看就是镜片一直在闪**。
   正解是 `win.setContentProtection(true)`（macOS 下即 `NSWindowSharingNone`），
   系统截图天然拍不到该窗口，镜片可以全程常显，既不闪也不会自拍。
9. **镜片窗口尺寸要比镜片大一圈** —— 圆形窗口需留出透明边给蓝色发光环（box-shadow），
   否则发光会被窗口边缘裁掉。本项目窗口 178px、镜片 150px、留白 14px。
10. **临时截图文件不能在送去 OCR 之前删** —— 曾经在 `lensTick` 里读完图就 `unlink`，
   紧接着又把同一个路径传给 `startOcr`，OCR 必然 `ENOENT` 失败，表现为
   **镜片只红闪、永远出不来译文**。现在的约定是：要做 OCR 就把删除责任交给
   `startOcr` 的 `finally`，不做 OCR 的帧才在 `lensTick` 里当场删。
11. **高频截图前必须做权限门禁** —— 没有屏幕录制权限时，每次 `screencapture` 都会被 TCC
   拦下并弹一次系统授权框。镜片循环每 110ms 截一次图 = **每秒弹 9 次弹窗**，用户只能强杀进程。
   必须在 `startMagnifier()` 里先用 `systemPreferences.getMediaAccessStatus('screen')`
   预检（该 API 只读状态、不会触发弹窗），无权限直接拒绝进入并弹一次引导框；
   同时加「连续失败 N 次自动熔断退出」兜底。
12. **ad-hoc 签名的授权无法跨重新打包保留** —— `codesign -d -r-` 显示
   `designated => cdhash H"..."`，即授权被死锁在一个精确哈希上。只要代码有任何改动、
   重新打包，cdhash 就变，macOS 会把它当成一个全新的 App，**之前授予的屏幕录制权限全部失效**。
   清理残留记录用 `tccutil reset ScreenCapture com.lee.magnifiertranslator`（无需 sudo）。
   要彻底摆脱这个循环，需要用一张固定的签名证书（自签名或 Developer ID）代替 ad-hoc。
13. **被静默吞掉的错误 = 最难查的 bug** —— `startOcr` 里翻译失败只 `console.warn` 就继续，
   然后照常发 `status:'done'` 让镜片绿闪，但 `translated` 是空字符串。镜片渲染的条件是
   `blocks.length && translated`，于是什么都不画。用户看到的是「绿闪了、但没有译文」，
   而日志在打包后又看不到，等于线索全断。**凡是 catch 住的错误，都必须有一条通向用户的路径。**
14. **打包后必须有文件日志** —— 从启动台打开的 `.app` 没有终端，`console.log` 全部蒸发。
   本项目用 `src/logger.js` 写到 `userData/logs/app.log`，并在托盘加「📄 打开日志」入口。
   没有它，「镜片没出译文」只能靠猜是 OCR 空、翻译超时还是网络不通。
15. **实时循环里的缓存阈值必须大于单轮耗时** —— 实测「OCR + 联网翻译」一轮 1.8~2.4 秒，
   而原先移动阈值只有 12px、缓存 TTL 2000ms。人手持续微动，12px 一碰就作废缓存重新识别，
   结果永远停在「识别中」、译文一次都出不来。已调整为 40px / 8000ms。
16. **不要在高帧率循环里降级到重量级引擎** —— 曾想在 Vision 返回空时降级 Tesseract 兜底，
   但 Tesseract 单次识别要数秒（CPU 密集），首次还要下载 40MB 语言包。镜片是 ~9fps 循环，
   用户移到空白处就会触发，立刻卡死。最终决定只在 Vision **抛错**（真正不可用）时才降级，
   返回空则如实提示「未识别到文字」。
17. **权限门禁不能只信 `getMediaAccessStatus`，更不能硬拦** —— 该 API 只查 TCC 记录，
   而 ad-hoc 签名的应用每次重新打包 cdhash 都变、旧记录随之失效，于是出现
   「系统设置里明明勾着，API 却返回 denied」的错配。此时若门禁直接 return，
   **镜片根本不会出现**，用户完全无从判断是权限问题还是程序坏了。
   正确做法是**双重验证**：API 说没有时，再用 `screencapture` 截 1×1 像素实测一次，
   能截到就以实测为准放行；实测也失败才拦。另外必须留逃生舱（权限框里的「仍要继续」），
   任何检测逻辑都可能误判，不能把用户彻底锁在门外。
18. **写权限探针时别复用带降级的截图函数** —— `captureRegion` 在 `screencapture` 失败后
   会降级到 `desktopCapturer`，而后者在无权限时往往返回一张**黑图却不抛错**。
   拿它探测权限会把「没权限」误判成「有权限」。探针必须直连 `screencapture`
   （见 `capture.js` 的 `probeScreencaptureAccess`），只认它的成败。
19. **用固定的自签名证书替代 ad-hoc，可根治反复重新授权** —— 见 `scripts/create-signing-cert.sh`。
   关键是证书要带 `extendedKeyUsage=critical,codeSigning`，导入后还必须
   `security add-trusted-cert` 设为受信任，否则 `find-identity` 会显示「0 valid identities」。
   签名后 requirement 从 `cdhash H"…"` 变成 `certificate leaf = H"…"`，
   只要不换证书，重新打包多少次授权都还在。
   注意：自签名仍无法通过 Gatekeeper 公证，分发给他人时对方依旧要手动放行。

## 依赖

| 包 | 用途 | 位置 |
|---|---|---|
| `electron` | 运行时 | devDependencies |
| `electron-builder` | 打包 | devDependencies |
| `tesseract.js` | OCR 兜底 | **dependencies** |

网络请求用 Node 内置 `fetch`，**不需要 axios**。

---

## License

[MIT](LICENSE) © 2026 Jackie Lee

## 贡献

欢迎提 Issue / PR 一起完善这个工具。

- 开发模式见上方「快速开始」；提交前请跑一遍 `npm start` 确认框选翻译与放大镜模式基本可用。
- 翻译默认走 DeepSeek（在面板 ⚙️ 填 `sk-` Key）；**不填 Key 也能用**，会自动降级到免费 MyMemory 接口，方便没有 Key 的贡献者本地验证。
- 打包 / 签名相关说明见上方「关于代码签名」「已知坑」。

> 注意：本项目仅适配 **macOS Apple Silicon**，依赖系统 Apple Vision 与屏幕录制权限。
