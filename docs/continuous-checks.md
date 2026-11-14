# Windows 自动检查、采样诊断与资源基线

[返回首页](../README.md)

这些工具仅用于开发验证。生产服务、26 / 17 个 MCP 工具和运行依赖保持不变。

## 自动检查

[Windows 工作流](../.github/workflows/windows.yml) 在 `main` 的 push、pull request 和手动触发时执行，不设定时任务。使用 Windows Server 2022 runner，分别运行 Windows PowerShell 5.1 与 PowerShell 7。Actions 固定到经核对的提交，工作流仅有仓库读取权限，不保留 Git 凭据。

每个任务安装 Node.js 24.14.0、uv 0.12.3，再用项目安装脚本准备锁定的 Python 3.12.13 环境，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/ci.ps1 -FreshInstall
# 或在 PowerShell 7 中
pwsh -NoProfile -File tests/ci.ps1 -FreshInstall
```

检查包含源码语法、安装诊断、故障注入、MCP 握手/禁用输入入口/暂停恢复/EOF 退出、空隐藏桌面 worker 恢复、资源基准，以及空缓存中文空格目录的全新和重复安装。`tests/run.ps1 -Headless` 是不依赖可见前台窗口的测试入口；它与 `-RealApps`、`-ParallelApps` 互斥。

CI 不启动 WPS、Edge、画图或用户文档，不把托管 Windows runner 的通过当成 Windows 11 应用兼容性或真人共存证明。本机完整回归仍运行 `tests/run.ps1`，真实应用按需显式追加原有参数。

当前运行的摘要、日志与资源报告位于 `tests/.work/ci/`，云端作为 artifact 保留 7 天，不上传个人应用截图、配置或其他历史报告。任一阶段失败则任务失败；资源数值本身没有虚构的通用合格阈值。工作流静态检查和本地同命令验证不等于 GitHub 实际运行通过；首次推送后需查看真实 Actions 结果。

本轮 [本地验证汇总](../reports/windows-checks-local.json) 记录了两版 PowerShell 的执行结果、82 项 Python 测试、完整隐藏桌面回归、只读监测边界测试，以及被测代码的 SHA-256；云端执行明确标为 `not_run`。

## 无效采样诊断

```powershell
.\runtime\Scripts\python.exe -B tests/foreground_probe.py --seconds 30 --output tests/.work/sampling.json
node tests/test_app_harness.mjs --live
```

第一条只读取桌面状态，第二条还验证监测器的接受/拒绝边界；二者均不发送输入或激活窗口。需要当前登录用户的可见桌面读取权限，不在云端 CI 中冒充真人前台测试。

新探针分别记录空前台、窗口/进程消失、游标读取失败、GUI 线程读取失败、输入桌面权限/读取问题，以及一次采样过程中前台窗口变化；可用时记录对应 Win32 错误码。GUI 信息按第一次观察到的具体线程读取，再检查前台是否变化，避免 `GetGUIThreadInfo(0)` 在中途切换后读取另一线程。最多保留 128 条失败细节并标明截断，总计数不截断。

本轮 [只读实测](../reports/sampling-diagnostics.json) 在 30 秒、1,458 个样本中记录一次 `FOREGROUND_NULL`。微软明确说明，`GetForegroundWindow` 在窗口失去激活时可能返回 NULL；`GetGUIThreadInfo` 也说明激活变化时句柄可能无效。[前台窗口文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow)、[GUI 线程文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo)。

这确认了本轮缺口的返回条件，不证明历史 Edge 的 4 个、记事本的 2 个样本原因相同：旧报告没有逐 API 记录，无法追溯。合法瞬态仍然是观察缺口，仍导致 `inconclusive`，不会重试后抹掉失败。读取不到桌面名称也不等于已经切换桌面；后者须有有效的不同名称作为证据。

独立探针的本机平均读取耗时约 0.254ms，30 秒 CPU 占用为单核约 0.729%，最大样本间隔约 22.942ms。完整共存监测另含进程树追踪，其开销另行记录，不能沿用这个数字。所有采样都不能排除间隔内的瞬时变化。

## 资源测试

```powershell
.\runtime\Scripts\python.exe -B tests/resource_usage.py --output tests/.work/resource-usage.json
```

基准分别启动 UIA 与隐藏路线的单个、三个服务，测量从启动到工具可用、空闲、隐藏 worker 首次启用、桌面释放和退出。创建的仅为空隐藏桌面，不启动任务应用。默认每个空闲阶段 3 秒，服务全部就绪后才测多服务并存。测试程序及用户应用不计入服务开销；Node、Python、原生后端与观测到的子进程计入。

以下为 [本机报告](../reports/resource-usage.json) 的近似中位数，只作基线：

| 服务状态 | 单服务私有提交 | 三服务私有提交 | 单服务工作集之和 | 三服务工作集之和 |
| --- | ---: | ---: | ---: | ---: |
| UIA 就绪空闲 | 30 MiB | 90 MiB | 68 MiB | 205 MiB |
| 隐藏 worker 启用后空闲 | 119 MiB | 358 MiB | 186 MiB | 559 MiB |

私有提交是已提交的私有内存，不等于常驻物理内存；工作集相加可能重复计算共享页。表中的“单服务”是单条路线，不是同时启用两条路线的总开销。3 秒空闲区间内 CPU 增量为零，只表示该短区间与系统计时精度下的观测，不表示永远零占用。

进程通过 PID、创建时间与保留句柄确认身份；退出后检查已观察服务进程和句柄是否清空。无法观测的进程、测量失败和清理残留均不能算通过；极短命、未被扫描捕获的进程仍属于覆盖边界。性能暂不设跨机器固定门槛，先积累同环境基线，再判断回归。
