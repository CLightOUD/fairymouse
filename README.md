# Fairymouse

轻量的 Windows 后台操作组件：保留两条已验证的路线，不包含虚拟机、RDP 初始化或常驻桌面界面。

| MCP | 用途 | 实现 |
| --- | --- | --- |
| `fairy-desktop` | 操作已有窗口的无障碍控件 | 修复版 agent-desktop 1.2.0，25 个工具 |
| `fairy-hidden` | 在隐藏桌面运行独立应用实例 | Python + Win32，11 个工具 |

默认保留并复用应用登录状态。隐藏桌面共享当前账号和文件，不是安全沙箱；单实例应用可能把请求转发到主桌面。窗口消息无法覆盖所有游戏、画布和组合快捷键。后台能力不支持时明确报告，不自动接管主桌面鼠标。

## 本机运行

Codex 使用已安装的 `D:\nodejs\node.exe` 启动两个入口：

```powershell
node D:\Fairymouse\desktop\background-mcp.mjs
node D:\Fairymouse\hidden\launch.mjs
```

入口通过 MCP stdio 通信，不监听网络端口，也不设置开机自启。更新配置后，新启动的 MCP 进程使用本目录；正在运行的聊天需要重启 Codex 才能重新连接。

技能源文件为 `skills/background-desktop/SKILL.md`，本机安装位置为 `~/.codex/skills/background-desktop/SKILL.md`。

## 目录与依赖

- `desktop/`：已修复的原生执行文件和后台工具过滤代理。
- `hidden/`：隐藏桌面适配器和实际使用的上游 Win32 后端。
- `python/`、`runtime/`：Python 3.12.13 与 MCP、Pillow 的固定运行依赖；属于可重建的安装内容，不进入 Git。
- `requirements.in`、`requirements.lock`：直接依赖和完整版本锁定。
- `patches/`、`licenses/`：原生补丁及第三方来源、许可证。
- `tests/`：可重复运行的测试源码。编译程序和临时数据写入被忽略的 `.work/`。
- `reports/`：小型验证和清理记录，不保存个人截图或浏览器配置。

独立 Python 运行时避免依赖 Codex 内置运行时路径。没有随组件复制 Node、Rust 编译器、SDK 或完整上游仓库。MCP SDK 的传递依赖按锁定文件保留；不通过删库碰运气缩小体积。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Fairymouse\tests\run.ps1
```

检查两个 MCP 的通信与工具范围，以及隐藏测试程序的填写、点击、中文、emoji、截图、主桌面拒绝和关闭。测试只操作专用隐藏窗口，不会自动操作用户应用。

## 重建与维护

Python 使用 uv 的 CPython 3.12.13 Windows x64 发行版。重建运行环境时，在本目录恢复同版本 Python，创建 `runtime` 虚拟环境，然后使用 `uv pip sync --python runtime/Scripts/python.exe requirements.lock` 安装锁定依赖。

`desktop/agent-desktop.exe` 为 v1.2.0 源码应用 `patches/agent-desktop-1.2.0.patch` 后的 Windows x64 构建。更新前需要验证上游是否已修复自动聚焦；不要直接覆盖本地修复版。

此仓库仅用于本地版本管理，不配置远程仓库，不上传账号、配置、运行时或用户数据。
