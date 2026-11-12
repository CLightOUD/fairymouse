# Fairymouse

**给 AI 一只不抢用户鼠标的后台鼠标。**

Fairymouse 是一个轻量的 Windows 后台操作工具组件，通过 MCP 接入 AI 客户端。它让 AI 读取控件、填写内容、点击按钮、检查结果，也能在隐藏桌面启动独立应用实例，让您继续使用自己的桌面。

设计原则很简单：**提高实际任务完成率，保持少量入口，不把电脑自动化做成另一套电脑。** 不引入虚拟机、RDP 或常驻操作界面；不向主桌面发送物理输入，也不在操作失败时自动抢前台。

> 当前面向 Windows x64，处于早期开发阶段。后台操作能力取决于应用实现；应用自身激活、单实例转发等行为仍需验证。“不抢鼠标”是设计约束，不能据此保证所有第三方软件永远不改变焦点。

## 两条路线

| MCP 服务 | 适合做什么 | 实现 |
| --- | --- | --- |
| `fairy-desktop` | 操作已有窗口中可访问的控件，复用当前登录状态 | 关闭自动聚焦的 UIA 后端，26 个工具 |
| `fairy-hidden` | 在隐藏桌面运行独立实例，执行可验证的后台任务 | Python + Win32，复用原生 UIA，17 个工具 |

已有窗口可以被遮挡；最小化窗口不保证可操作。隐藏桌面不会切换到用户眼前，也不能把已经打开的窗口搬过去。

## 已具备的能力

- **目标引用**：观察后获得短期 `ref`，操作前检查目标身份；引用过期或目标变化就拒绝，不猜另一个控件。
- **差异反馈**：按快照基线返回新增、移除和变化的控件，减少重复读取。
- **动作后验证**：区分消息投递、控件回读与业务完成；支持条件等待，保存任务仍需检查实际文件。
- **恢复与暂停**：隔离可能卡死的原生调用，支持暂停、恢复和重新观察；结果未知时不自动重放动作。
- **常用控件**：点击、文本编辑、复选框、列表选择、滚动，以及 UIA 菜单展开与折叠。
- **多 agent 并行**：每个 agent 使用独立 MCP 进程和不同名称的隐藏桌面；跨进程占用锁阻止同名桌面被重复操作。
- **统一结果**：两条路线都返回 `structuredContent.fairy`，让调用方判断成功范围、错误与重试安全性。

这里的“多个鼠标”指多个独立后台操作通道，不是多个系统物理光标。

## 快速开始

准备 Windows x64、Git、[Node.js](https://nodejs.org/) 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)，确保 `node`、`uv` 在 PATH 中。本机验证使用 Node.js 24.14.0、uv 0.12.3；其他版本尚未逐一验证。

在 PowerShell 中运行：

```powershell
git clone https://github.com/CLightOUD/fairymouse.git
cd fairymouse
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
node scripts/doctor.mjs
node scripts/configure.mjs
```

安装脚本会准备项目内的 Python 3.12.13 环境，按锁定文件安装依赖。首次安装需要联网下载；不修改 AI 客户端设置，不添加服务或开机启动。可先加 `-DryRun` 查看计划，或用 `-Check` 只做诊断。

`configure.mjs` 输出带绝对路径的 `mcpServers` JSON。将其中的服务名称、`command` 和 `args` 配置到支持 MCP stdio 的客户端；客户端使用其他配置格式时，按其要求填写这些字段。配置后重新连接 MCP 服务。

两个入口分别是 `desktop/background-mcp.mjs` 和 `hidden/launch.mjs`，均通过本地标准输入输出通信，不监听网络端口。迁移项目目录后，重新生成配置。

可选的 AI 操作指引见 [background-desktop 技能](skills/background-desktop/SKILL.md)。它是使用说明，不是运行依赖。

## 让 AI 完成一次任务

建议遵循“观察 → 操作一次 → 验证”的循环：

1. 选择路线。已有窗口优先使用 UIA；需要隔离的新实例才创建隐藏桌面。
2. 隐藏路线调用 `hidden_create`、`hidden_launch`，再用 `hidden_windows` 确认实际窗口归属。
3. 使用 `hidden_observe` 读取原生控件，或用 `hidden_semantic(action="snapshot")` 观察 UIA 树，获取新引用。
4. 对已确认的目标执行一次操作，再读取状态、等待条件或比较快照差异。
5. 按任务核对结果：例如保存后回读文件，而不是只看到“保存”按钮被点击。
6. 关闭本次启动的应用，确认退出，再释放隐藏桌面。

`posted` 只表示消息已投递；`completed_unverified` 不代表任务完成；`verified` 也仅覆盖工具明确声明的验证范围。超时不等于动作没有执行，先观察，再决定下一步。

参数、状态码、引用有效期与恢复规则见 [AI 调用参考](docs/tool-reference.md)。

### 多个 agent 同时操作

```powershell
node scripts/configure.mjs --agents writer,reviewer
```

这会生成独立的 `fairy-hidden-writer` 和 `fairy-hidden-reviewer` 配置。让每个 agent 使用各自的服务进程，并选择不同的桌面名称。同一隐藏服务内部串行执行，不把多个 agent 的变更混入一个队列。

不同桌面仍共享 Windows 账号、文件系统及部分应用状态。它们不是安全沙箱；单实例应用也可能转发请求，因此不能靠桌面名称隔离用户数据。

## 实际验证到了哪里

以下为当前机器上的特定版本与测试场景，详细版本、结果和时间记录在报告中，不代表整款软件的所有功能都兼容。

| 应用 / 场景 | 已核对的实际结果 | 报告 |
| --- | --- | --- |
| 现代记事本 | 正常编辑、通过文件菜单保存，磁盘内容精确回读 | [记事本](reports/real-apps.json) |
| WPS Writer | RTF 与 DOCX 编辑保存；DOCX 退出后解包核对原文与新增文字 | [RTF](reports/wps-apps.json)、[DOCX / XLSX](reports/wps-formats.json) |
| WPS 表格 | XLSX 文本、数值、公式保存；退出后核对公式及缓存结果 `26` | [DOCX / XLSX](reports/wps-formats.json) |
| Edge | 网页表单填写与导出；原生“另存为”对话框保存 HTML 并核对唯一标记 | [表单](reports/edge-apps.json)、[原生另存为](reports/edge-native-save.json) |
| Windows 画图 | 图片旋转并保存，退出后核对尺寸及全部像素 | [画图](reports/paint-apps.json) |
| 三路并发 | WPS 表格、Edge、画图在独立 MCP 进程与桌面执行，变更请求实际重叠，分别核对文件 | [并发](reports/parallel-apps.json) |
| Windows 计算器 | 本机 UWP 激活入口无法保证隐藏桌面归属，仅预检，未启动 | [不支持记录](reports/calculator-apps.json) |

Edge 回归中的 CDP 只读取几何与状态，实际输入和原生保存由 Fairymouse 执行。并发回归测试的是工具调用隔离与执行能力，不是大模型规划能力。

验证记录包含前台窗口、焦点和鼠标采样。采样不能排除间隔内的瞬时变化，也不能自动区分用户活动与工具影响；[早期异常观察](reports/app-regression-observations.json) 单独保留。同机中文空格路径、空缓存的 [全新安装验收](reports/clean-install.json) 已通过，第二台干净机器尚未验证。

安装、真实 AI 决策和用户前台共存的测试方法见 [验收说明](docs/acceptance.md)。这些均为测试材料，不增加产品模型依赖；[共存并发报告](reports/parallel-coexist.json) 与原来的静止基线报告分别保存。

## 边界

- 不提供主桌面物理输入、自动聚焦、自动恢复最小化窗口或桌面切换作为兜底。
- 游戏、原始输入、自绘画布、部分 GPU 窗口和组合快捷键可能不接受窗口消息；截图也可能为空或黑屏。
- UIA 控件回读不等于应用已经提交或写盘；不支持的能力和无法确认的结果应明确报告。
- 默认不清理登录状态、不要求访客模式。需要独立配置的应用应由调用方明确选择，不能擅自复制或修改用户配置。

## 测试与维护

```powershell
# 安装诊断：不启动用户应用
node scripts/doctor.mjs

# 单元、协议与专用隐藏窗口回归
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1

# 额外运行已安装应用的真实文件任务及三路并发回归
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1 -RealApps -ParallelApps
```

真实应用测试使用临时文件和本次启动的隐藏实例；不支持的环境会记录跳过，不能将跳过当作通过。WPS 已运行时会避开测试，以降低单实例转发风险。运行结果保存在 `reports/`，临时文件在 `tests/.work/`。

核心目录：`desktop/` 为 UIA 代理与修复版原生后端，`hidden/` 为隐藏桌面服务，`scripts/` 为安装与配置工具，`tests/` 为回归源码。Python、缓存、临时截图及个人实测录屏不进入 Git。

原生后端的固定源码版本、补丁和构建方法见 [重建说明](docs/development.md)。依赖通过 `requirements.lock` 锁定；贡献时优先补足常用任务的可验证完成能力，保持两条路线和清晰边界。

## 许可证

Fairymouse 原创代码采用 **GNU GPL v3.0（GPL-3.0-only）**，详见 [LICENSE](LICENSE)。Copyright (C) 2026 CLightOUD and Fairymouse contributors。

第三方组件保留各自的许可证与声明，见 [第三方来源](licenses/THIRD_PARTY.md)。本项目为独立社区项目，与《绝区零》官方无关联。

## Fairy 的两句附言

> “主人，鼠标留给您，后台交给我。至高助手不需要靠抢光标证明存在感。”
>
> “多开几个代理？当然可以。不过，电费并不会因为本项目叫‘轻量’就学会谦虚。”

*以上为 Fairy 风格的原创玩笑，非游戏原台词。*
