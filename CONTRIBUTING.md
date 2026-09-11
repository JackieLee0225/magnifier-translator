# 贡献指南 / Contributing

非常感谢你愿意一起来完善这个翻译放大镜！本项目目前仍是一个**未完成的项目**，欢迎任何方向的帮助。

Thank you for helping build out this translation magnifier! This is still an **unfinished project** — contributions in any direction are welcome.

> 项目愿景与现状见 [README](README.md) 的「项目状态 & 愿景」一节。
> See the **Project Status & Vision** section in [README](README.md) for the goal and current state.

---

## 开发环境 / Dev Environment

| 要求 | 说明 |
|---|---|
| 系统 | **macOS Apple Silicon**（依赖 Apple Vision 与屏幕录制权限，暂不支持 Windows/Linux） |
| Node | 建议 18+（Electron 26 运行时） |
| 工具 | Xcode Command Line Tools（`ocr.swift` 需本机编译） |

```bash
git clone https://github.com/JackieLee0225/magnifier-translator.git
cd magnifier-translator
npm install              # 安装依赖
npm run build:ocr        # 编译 Apple Vision OCR 二进制（只需一次）
npm start                # 启动开发模式
```

首次框选时 macOS 会弹「屏幕录制」授权 → 允许 → **完全退出重启 App** 才生效
（系统设置 → 隐私与安全性 → 屏幕录制）。

---

## 不填 API Key 也能跑 / Runs without an API Key

翻译默认走 DeepSeek，但**没 Key 也能用**：会自动降级到免费的 MyMemory 接口。
方便没有 Key 的贡献者在本地验证功能，无需任何配置。

Translation defaults to DeepSeek, but **works without a key** — it falls back to the free
MyMemory endpoint. Contributors can verify locally with zero config.

---

## 代码规范 / Code Conventions

- **所有路径统一由 `src/paths.js` 解析**，业务代码里不要写死绝对路径 / 相对路径 / `cwd` 依赖。
  All paths go through `src/paths.js`; never hardcode absolute/relative paths or rely on `cwd`.
- **密钥绝不落盘明文**：API Key 用 Electron `safeStorage` 加密存储，明文不要写进任何文件或提交。
  Never commit plaintext secrets; keys are encrypted via `safeStorage`.
- 实时循环（放大镜模式）里的防递归、权限门禁、缓存阈值等坑，见 README「已知坑」。
  See README's "已知坑" for real-time-loop pitfalls (recursion guard, permission gating, cache thresholds).

---

## 提 Issue / Filing Issues

任何问题、建议、想要的功能都欢迎开 Issue。建议包含：

Open an issue for bugs, ideas, or feature requests. Please include:

- 复现步骤 / Steps to reproduce
- 期望 vs 实际 / Expected vs actual
- 系统版本、App 版本 / macOS version, app version
- 相关的日志（托盘菜单「📄 打开日志」）/ Relevant logs (tray menu → "📄 打开日志")

---

## 提 PR / Submitting a Pull Request

1. Fork 本仓库到你的账号 / Fork the repo to your account.
2. 从 `main` 切出功能分支：`git checkout -b feat/your-feature` / Create a branch off `main`.
3. 提交前跑一遍 `npm start`，确认框选翻译与放大镜模式基本可用。
   Run `npm start` and sanity-check select-translate + magnifier before committing.
4. 提交信息用中文或英文均可，建议清晰描述「做了什么 / why」。
   Commit messages in Chinese or English are both fine; describe what and why.
5. 推到你的 Fork 后，在 GitHub 开 PR 到本仓库的 `main`。
   Push and open a PR against this repo's `main`.
6. 如果是大改动，建议先开一个 Issue 讨论方向，避免做了白做。
   For large changes, open an issue first to align on direction.

---

## 方向参考 / Where Help Is Needed

- **实时镜面**：对标 iPhone 相机翻译的「镜框内实时翻译覆盖」体验
- **翻译质量**：更多引擎、术语表、离线模型
- **性能**：降低 OCR + 翻译延迟，让镜面更跟手
- **UI / 文档**：更顺手的交互、双语文档、截图示例

---

## License

[MIT](LICENSE) © 2026 Jackie Lee
