# dsh-desktop

DeepSeek Harness 的 Electron 桌面壳 —— 把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 官方的 Web UI 装进桌面应用：托盘常驻、系统通知、开机自启，开箱即用（内置 Node 运行时，无需手动安装依赖）。

> dsh 处于 developer preview（当前依赖锁定 `@deepseek-ai/dsh@0.1.0-rc.6`），接口可能有破坏性变更，升级时注意锁版本。

## 功能

- **内嵌官方 GUI**：spawn `dsh web --port 0`（随机端口），窗口加载 loopback HTTP，信任围栏天然通过
- **进程托管**：启动 URL 解析、健康检查、崩溃自动重启（指数退避，最多 3 次）、SIGTERM 优雅退出、防双进程
- **托盘**：显示/隐藏、开机自启开关、最小化到托盘开关
- **系统通知**：通过 dsh 公开的下行 WebSocket 流（`/api/events.mux` + `/api/events.host`）监听 `approval/requested` 与 `turn/end`，权限请求和任务完成时弹 Windows 通知（30s 去抖 + 会话标题缓存）
- **单实例锁**：重复启动唤起已有窗口
- **打包分发**：electron-builder NSIS 安装包，内置 Node v24 运行时（91MB）与全部依赖，目标机器零前置要求

## 快速开始（开发）

```bash
npm install
npm start
```

首次启动会在 `Settings → Models` 配置 API Key（存入 `$DSH_HOME`，官方设置页原生支持）。

## 构建安装包

```bash
# 1. 准备捆绑的 Node 运行时（一次性）
#    从 https://npmmirror.com/mirrors/node/v24.14.1/node-v24.14.1-win-x64.zip
#    解压 node.exe 到 resources/node/node.exe

# 2. 打包
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

产物：`dist/dsh Desktop Setup <version>.exe`（NSIS 向导式安装，中文界面）。

构建配置要点：

- `asar: false` —— 捆绑的独立 `node.exe` 无法执行 asar 内的 JS，dsh 代码必须以明文文件存在
- `npmRebuild: false` —— dsh 的原生模块（sharp/koffi/node-pty）是 prebuilt N-API，跑在捆绑 Node 里，Electron 主进程不加载它们，无需为 Electron 重编译
- `extraResources` 打包 `resources/node` → 安装目录 `resources/node`，运行时 `findNodePath()` 优先使用

## 架构

```
src/main.mjs           Electron 主进程：窗口、托盘、单实例锁、生命周期编排
src/dsh-process.mjs    纯 Node 子进程托管：spawn/URL 解析/健康检查/重启/优雅停止（可单测）
src/notifier.mjs       下行 WS 流监听 → 系统通知（Node 原生 WebSocket，零依赖）
src/settings.mjs       userData/settings.json 持久化（窗口状态、托盘偏好）
test/                  node:test 单测
scripts/gen-icon.mjs   零依赖 PNG 图标生成
```

## 测试

```bash
npm test
```

## 已知限制

- 静默安装（`/S`）在向导式安装器上不生效，请手动点击安装（一次性影响）
- 强杀进程不保证走优雅退出（但 Electron 的 Job Object 会连带清理 dsh 子进程，无孤儿）
- 上游未提供的能力（worktree、语音、日程 UI）不在此壳范围内

## 上游

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— "Everything is a Plugin" 的 agent harness
- 桌面壳模式参考 [OpenChamber](https://github.com/openchamber/openchamber)（Electron 内嵌 web server + 受管 agent 子进程）
