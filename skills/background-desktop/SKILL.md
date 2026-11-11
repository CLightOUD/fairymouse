---
name: background-desktop
description: 在 Windows 上进行后台电脑操作，尽量避免抢用户鼠标和前台。用于已有软件的后台读取、填写、点击，以及在隐藏桌面启动独立应用实例；使用本机 fairy-desktop 与 fairy-hidden MCP。文件处理和有专用接口的任务优先使用专用工具。
---

# Fairymouse 后台操作

组件与本地仓库位于 `D:/Fairymouse`。目标是轻与强；不引入虚拟机、RDP 初始化或常驻界面来扩大少量特殊任务的覆盖面。

## 选择路线

- 已有窗口：使用 `fairy-desktop`。这是关闭 UIA AutoSetFocus 的 agent-desktop 1.2.0 本地修复版，开放 25 个读取或后台语义工具。窗口可以被遮挡；最小化窗口未获得通用保证。
- 需要隐藏的新实例：使用 `fairy-hidden`。它开放 11 个 Win32 隐藏桌面工具，不切换用户桌面、不发送物理输入。
- 浏览器、文件、文档等有可靠专用接口时，优先使用这些接口。不能后台处理的原始输入、复杂拖拽或 GPU 画布，明确报告局限；不自动转为前台操作。

用户希望沿用 Windows 和应用登录状态。实际任务优先保留并复用登录，不默认使用访客模式或清理配置。隐藏桌面共享账号与文件；单实例软件和被占用的浏览器配置可能把请求转发到主桌面。先确认实例实际所在桌面，必要时改用已有窗口的语义操作或应用支持的多实例方式。

## 已有窗口

先通过 `desktop_skills_get` 阅读 `desktop` 和 `platform` 指南，再观察、操作、独立核对结果。使用最新快照返回的 ref；文字优先 `set-value`，复选框优先幂等 `check`/`uncheck`。

MCP 暂未加载时可调用 `D:/Fairymouse/desktop/agent-desktop.exe`；设置 `AGENT_DESKTOP_HOME=D:/Fairymouse/desktop/state`。不要向主桌面发送物理鼠标、`press`、`type` 或 `--headed`，也不要使用聚焦、恢复窗口来冒充后台操作。

UIA 修复不保证应用自己不会激活。新应用先做小范围可逆验证，观察到干扰就停止此路径。不要用 npm 自动覆盖本地修复版。

## 隐藏桌面

1. `hidden_create` 使用 `FairyHidden-<ASCII任务名>`。
2. `hidden_launch` 传绝对可执行文件路径与参数数组。
3. 用 `hidden_windows`、`hidden_controls` 获取当前 HWND，并通过 `hidden_screenshot` 观察。
4. 输入框优先 `hidden_set_text`；字符使用 `hidden_type_text`。`hidden_click` 的坐标相对目标 HWND 客户区，可直接定位子控件句柄以避免标题栏偏移。
5. 独立核对效果。`hidden_keys` 是按键消息，不保证所有组合键生效。调用超时不等于动作未执行，先观察再决定是否重试。
6. 保存成果后请求 `hidden_close_window`；确认任务应用退出后 `hidden_release`。不要关闭不属于当前任务的实例。

服务核对每个 HWND 的真实桌面归属，拒绝主桌面窗口和保留桌面名称，并适配目标 DPI。GPU 窗口仍可能黑屏。隐藏桌面不是安全沙箱，也不能搬走已有窗口。

## 验证与维护

原版抢前台问题曾复现；修复版 36 次语义操作核对通过。隐藏路线已验证 WinForms 控件、中文、emoji，以及 Edge 本地页面。未验证所有软件。

迁移后的两个 MCP 及隐藏动作测试位于 `tests/run.ps1`，结果在 `reports/`。运行时与缓存不入 Git。两个服务均为本地 stdio，启动器隐藏控制台；修改路径后需要让 Codex 重新启动 MCP 进程。
