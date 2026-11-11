---
name: background-desktop
description: 在 Windows 上进行后台电脑操作，尽量避免抢用户鼠标和前台。用于已有软件的后台读取、填写、点击，以及在隐藏桌面启动独立应用实例；使用本机 fairy-desktop 与 fairy-hidden MCP。文件处理和有专用接口的任务优先使用专用工具。
---

# Fairymouse 后台操作

先从 MCP 启动配置确认 Fairymouse 仓库的绝对路径；下文的 `<repo>` 指该目录，不假定固定盘符。目标是轻与强；不引入虚拟机、RDP 初始化或常驻界面来扩大少量特殊任务的覆盖面。

## 选择路线

- 已有窗口：使用 `fairy-desktop`。这是关闭 UIA AutoSetFocus 的 agent-desktop 1.2.0 本地修复版，开放 26 个读取、后台语义或控制工具。窗口可以被遮挡；最小化窗口未获得通用保证。
- 需要隐藏的新实例：使用 `fairy-hidden`。它开放 17 个隐藏桌面或控制工具，可复用现有原生 UIA，不切换用户桌面、不发送物理输入。
- 浏览器、文件、文档等有可靠专用接口时，优先使用这些接口。不能后台处理的原始输入、复杂拖拽或 GPU 画布，明确报告局限；不自动转为前台操作。

用户希望沿用 Windows 和应用登录状态。实际任务优先保留并复用登录，不默认使用访客模式或清理配置。隐藏桌面共享账号与文件；单实例软件和被占用的浏览器配置可能把请求转发到主桌面。先确认实例实际所在桌面，必要时改用已有窗口的语义操作或应用支持的多实例方式。

## 已有窗口

先通过 `desktop_skills_get` 阅读 `desktop` 和 `platform` 指南，再观察、操作、独立核对结果。使用最新快照返回的 ref；文字优先 `set-value`，复选框优先幂等 `check`/`uncheck`。

MCP 暂未加载时可调用 `<repo>/desktop/agent-desktop.exe`；将 `AGENT_DESKTOP_HOME` 设置为 `<repo>/desktop/state` 的实际绝对路径。不要向主桌面发送物理鼠标、`press`、`type` 或 `--headed`，也不要使用聚焦、恢复窗口来冒充后台操作。

UIA 修复不保证应用自己不会激活。新应用先做小范围可逆验证，观察到干扰就停止此路径。不要用 npm 自动覆盖本地修复版。

## 隐藏桌面

1. `hidden_create` 使用 `FairyHidden-<ASCII任务名>`。
2. `hidden_launch` 传绝对可执行文件路径与参数数组。
3. 用 `hidden_windows`、`hidden_controls` 获取当前 HWND，并通过 `hidden_screenshot` 观察。
4. 输入框优先 `hidden_set_text`；字符使用 `hidden_type_text`。`hidden_click` 的坐标相对目标 HWND 客户区，可直接定位子控件句柄以避免标题栏偏移。
5. 独立核对效果。`hidden_keys` 是按键消息，不保证所有组合键生效。调用超时不等于动作未执行，先观察再决定是否重试。
6. 保存成果后请求 `hidden_close_window`；确认任务应用退出后 `hidden_release`。不要关闭不属于当前任务的实例。

### 结构化结果与恢复

- 优先 `hidden_observe` 获取 ref，然后 `hidden_act` 点击或设置文字；可指定 `expect_ref` 与 `expect_text` 进行动作后验证。文字/位置/身份变化使引用失效，操作后重新观察。旧快照可以传 `baseline` 获取差异；差异不证明业务成功。
- 文档 Edit/RichEdit 优先用 `hidden_act(action="replace_text", text=...)` 产生正常编辑事件；`set_text` 只保证文字回读。现代记事本不能依赖消息 Ctrl+S 保存。
- 隐藏窗口自绘菜单可用 `hidden_semantic(name, hwnd, action="snapshot")`，再按返回引用 `expand/click/collapse/set_value`（设置值用 `value`）。只作用于指定隐藏顶层窗口，不使用聚焦或物理输入；动作消费引用，必须重新观察。记事本使用观察到的“文件”→“保存”，不要误用“全部保存”影响其他恢复标签页。最后独立读取目标文件判断业务完成。
- 已有新快照的 UIA 物理坐标时，可显式选择 `hidden_click(name, hwnd, x, y, coordinate_space="screen")`。工具只在该隐藏 HWND 子树内映射并适配 DPI，仍发送窗口消息。不能把调用返回当成保存成功，也不要自动重放结果未知的变更。WPS RTF 测试通过了这条保存路径；不代表全部 WPS 功能通用兼容。
- WPS 表格的匿名文本框可能返回 `AMBIGUOUS_TARGET`，不得任选同类控件。可按新快照中已辨认的公式栏坐标点击，使用返回的 `target_hwnd` 发送字符及单个回车；每次导航后重新读取名称框，确认单元格地址再编辑。追加与覆盖要分别验证，保存后解包 XLSX 核对单元格、公式与缓存值。
- Edge 原生另存为需要等待保存对话框真正可读，按观察到的文件名字段与保存按钮操作；文件出现后还需等对话框关闭，再关闭浏览器并释放。只读等待可以有界轮询，不重复保存动作。DOCX/XLSX、Edge 原生保存、画图旋转和多进程并发的可重复测试见 `tests/run.ps1 -RealApps -ParallelApps`。
- 每个 agent 使用独立 MCP 进程和不同的隐藏桌面名，才能并行。桌面第一次访问即被该进程占用，其他进程访问同名桌面会收到 `DESKTOP_OWNED`；不要重试争抢，改用自己的桌面。完成后关闭所属实例并释放。不跨任务复用引用。

- 读取 `structuredContent` 和 `isError`。`posted` 只表示消息投递；`verified` 只表示工具说明中的条件满足，不能扩大为业务任务完成。
- `hidden_launch` 默认观察 2 秒，只有同 PID 窗口出现在指定桌面才返回 `verified`。`launched_unverified` 不等于启动失败，不能盲目重新启动；子进程 GUI 需单独观察。
- `hidden_set_text` 自动回读；`hidden_controls` 可按文字、类名或控件 ID 精确筛选。多个匹配必须进一步辨认。`client_left/client_top` 是父客户区坐标，旧 `left/top` 仍是外窗口坐标。
- `hidden_wait` 等待窗口出现、顶层窗口关闭、文字相等或当前服务启动的进程退出。窗口关闭不等于进程退出；释放前可用 `process_exited` 与启动 PID 验证。
- `BUSY` 拒绝排队；超时或工作进程丢失表示动作结果未知，不重试变更。隐藏服务会回收原生工作进程，保留监督进程中的桌面占用和已确认应用句柄，随后重新观察；旧引用失效。整个 MCP 服务退出后的任务所有权不持久化。
- 两条路线均检查 `structuredContent.fairy` 的版本、状态、验证与重试字段，保留旧字段兼容。`hidden_control` / `desktop_control` 提供暂停、恢复与诊断；暂停不撤销已接纳动作。UIA 后端恢复后仍需 resume 和新快照，原来派生的动作子进程可能继续完成。
- `hidden_act` 可 check/uncheck 标准复选框、select 指定索引、scroll 指定行数。自定义或禁用控件明确拒绝。三态控件最多点击一次后回读，不匹配就停止。滚动观察到的变化不代表完成所有请求距离。
- 会话记录仅限当前服务进程；重启后用已知桌面名重新观察，不能把历史 PID 当作恢复的所有权。截图可传 `max_size` 减少图像体积。
- 安装异常可运行 `node "<repo>/scripts/doctor.mjs"`，只做本地诊断。

服务核对每个 HWND 的真实桌面归属，拒绝主桌面窗口和保留桌面名称，并适配目标 DPI。GPU 窗口仍可能黑屏。隐藏桌面不是安全沙箱，也不能搬走已有窗口。

## 验证与维护

原版抢前台问题曾复现；修复版 36 次语义操作核对通过。隐藏路线已验证 WinForms 控件、中文、emoji，以及 Edge 本地页面。未验证所有软件。

迁移后的两个 MCP 及隐藏动作测试位于 `tests/run.ps1`，结果在 `reports/`。运行时与缓存不入 Git。两个服务均为本地 stdio，启动器隐藏控制台；修改路径后需要让 Codex 重新启动 MCP 进程。
