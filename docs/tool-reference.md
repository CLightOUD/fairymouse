# AI 调用参考

[返回项目首页](../README.md)

## AI 调用约定

### 引用、差异与多个 agent

推荐流程：`hidden_create` → `hidden_launch` → `hidden_observe` → `hidden_act` → `hidden_observe(baseline=...)` → 关闭与释放。

`hidden_create` 的 `already_exists` 区分新建与重新打开；它不表示桌面内没有其他应用或任务已经完成，仍需观察窗口与进程。

- `hidden_observe(name, hwnd)` 返回控件与不透明 `ref`。`text` 做局部文字筛选，`limit` 限制输出，`truncated` 明确指出输出截断。最多缓存 32 个快照，每次最多 500 个控件、128K 文字字符；超限要求选择更小的父窗口。快照与引用有效期 60 秒，不持久化。
- 引用绑定服务实例、桌面、进程创建时间、线程、HWND、父窗口、控件类/ID、位置尺寸与文字。操作前重新检查，变化或过期返回 `STALE_REF`，不会猜测另一个目标。不可验证控件的 `ref` 为 null。此检查降低句柄复用风险，但不能证明同进程中销毁重建、且所有观测属性完全相同的控件仍是原对象；检查与消息投递也不是操作系统原子事务。
- `hidden_act(name, ref, action="set_text", text="...")` 写入并回读。`action="click"` 点击该控件客户区中心；可以同时提供 `expect_ref`、`expect_text`、`timeout_ms`，只执行一次动作，再等待指定控件文字。返回的 `action` 与 `verification` 分开表达。验证超时或目标变化不代表动作未执行，不自动重试。
- 编辑文档时可用 `hidden_act(..., action="replace_text", text="...")`：仅对可识别、可写的 Edit/RichEdit 使用选择全文和可撤销替换消息，让应用收到正常编辑事件。旧 `set_text` 保留原有行为。两者的控件回读都不等于文件已保存。
- 自定义菜单和控件可用 `hidden_semantic(name, hwnd, action="snapshot")` 取得隐藏窗口的 UIA 树，再使用 `click/expand/collapse/set_value` 和该快照的 `ref`。`set_value` 使用 `value` 参数。引用限定服务、桌面、顶层窗口，60 秒过期，变更后重新观察；原生后端也重新解析目标。复用已修复的原生组件，不增加第三方依赖；每次调用启动一个短命 helper，8 秒上限，Job Object 只回收 helper 树。快照深度 20、输出最大 2 MB，最多保存 16 个窗口作用域；文件保存需另行回读。暂停期间仍允许 snapshot。
- 变更请求使该桌面旧引用失效；旧快照仍可作为差异基线。`hidden_observe(..., baseline=snapshot)` 返回新增、移除和字段变化，以及新引用。读取差异不等于验证业务成功。旧 HWND 接口保留兼容，但不提供引用级别的身份保证。
- 多 agent 并行采用**每个 agent 一个 MCP 服务进程、一个不同名称的隐藏桌面**。同一服务内部继续串行，避免复杂调度；不同服务可并行操作各自应用。首次访问桌面即取得独占占用；其他 Fairymouse 服务访问同名桌面返回 `DESKTOP_OWNED`。占用由当前 Windows 用户本地目录的操作系统文件锁维护，释放或进程退出时解除；不会按时间强制抢占仍在执行的任务。空锁文件不含窗口内容或凭据。
- 占用保护只协调遵守协议的 Fairymouse 隐藏服务，不是权限隔离；其他程序、UIA 路线与单实例应用不受该锁约束。多个任务可能仍共享文件、账户和应用内部状态，不能把不同桌面当作数据沙箱。
- 本项目的“多个鼠标”是多个独立后台操作通道，不是多个系统物理指针；不会注入主桌面鼠标输入。不保证应用自身永不抢焦点，也不支持所有画布、游戏或组合快捷键。

验证脚本包含引用、跨进程占用、标准控件、真实阻塞工作进程回收测试，以及两个 MCP 进程在不同隐藏桌面同时写入真实测试控件、互不串写的回归。协议、暂停恢复和安装配置也纳入验证。真实应用使用 `node tests/real_apps.mjs --run` 测试记事本编辑、保存及文件精确回读；不支持的安装明确跳过，失败与清理结果写入 `../reports/real-apps.json`。

保留原有工具名称与必需参数，新增 `hidden_wait`、`hidden_status`、`hidden_observe` 和 `hidden_act`。读取列表继续返回 `structuredContent.result`；动作直接返回结构化字段。工具提供 MCP 的只读/破坏性提示，调用方仍须依据真实任务授权操作。

| 返回状态 | 含义 | 下一步 |
| --- | --- | --- |
| `posted` | 消息成功投递，尚未确认应用效果 | 用读取或 `hidden_wait` 检查；不能直接宣告任务完成 |
| `verified` | 已满足该工具声明的验证范围 | 文本回读不等于业务提交完成；启动验证仅证明同 PID 窗口位于指定桌面 |
| `launched_unverified` | 已创建进程，未观察到同 PID 窗口 | 检查窗口/进程；不要直接再次启动。子进程承载 GUI 的应用可能得到此状态 |
| `not_observed` | 等待期限内未观察到条件成立 | 不代表先前动作没有执行 |
| `verification_failed` / `error` | 验证失败或执行异常，MCP `isError=true` | 阅读 `code` / `message`（异常）并检查状态 |

`hidden_set_text` 自动执行限时回读；点击、按键、字符及关闭请求只承诺消息投递。变更操作均不自动重试。`BUSY` 表示请求没有入队；`TIMEOUT_UNKNOWN_OUTCOME` 表示应用可能仍处理已收到的消息。隐藏路线按需启动一个无控制台原生工作进程，内层超时或外层期限耗尽后回收该工作进程；监督进程保留桌面占用、桌面句柄及已确认启动的进程句柄。下一次读取使用新工作进程，旧引用失效，不杀任务应用、不重放动作。启动动作在返回前卡住时仍可能产生未确认实例，必须重新枚举，不能重复启动。

### 统一协议与暂停

两个 MCP 均在 `structuredContent.fairy` 提供 `{version:"1", route, status, verified, retry_safe}`；异常包含 `code/message`，保留原有内容和字段。`observed` 表示读到了状态，`completed_unverified` 表示工具返回但无独立验证，不能作为业务完成证据。图片仍保留原生图像内容。客户端优先检查 `isError` 与 `fairy`，需要路线特定信息再读取旧字段。

`hidden_control` 和 `desktop_control` 支持 `status/pause/resume/recover`。暂停阻止新变更，保留只读观察，不取消已接纳的操作。隐藏恢复须等当前请求结束或超时，仅回收原生工作进程，保留应用；恢复执行也使引用失效。UIA 代理超时后暂停并要求显式恢复，恢复后仍需 resume 和新快照。UIA 上游另派生的动作子进程可能继续完成，因此不能把后端重启当成撤销输入。

`hidden_act` 除点击和文本外，还支持 `check/uncheck`、`select(value=索引)`、`scroll(value=带符号行数)`。仅支持可识别的标准控件，检查禁用状态、类型和索引；选择操作通知父窗口并回读。滚动报告实际视口变化，不把边界未移动当作已完成指定距离。复选框最多触发一次点击，三态控件若进入非期望状态返回验证失败，不循环点击。

`hidden_wait` 支持 `window_exists`（标题/PID 精确筛选）、`window_closed`（已观察的顶层 HWND）、`text_equals`（HWND 与精确文字）、`process_exited`（当前服务启动的 PID），最长等待 10 秒。正常条件未满足返回 `not_observed`；观察本身失败则返回错误。并发请求不会排队操作应用，状态查询除外。

`hidden_controls` 支持 `text`、`class_name`、`control_id` 精确筛选；不会擅自选择多个匹配项中的第一个。旧 `left/top` 保持外窗口坐标，新 `client_left/client_top` 为传入父窗口的客户区坐标；点击仍可直接使用子控件 HWND。

`hidden_click(..., coordinate_space="screen")` 接受新 UIA 快照中的物理屏幕坐标，限定在传入隐藏 HWND 的可见子树内，按原生子窗口 Z 序逐层命中；每层从原物理坐标重新转换到该窗口 DPI 下的客户区。不会按面积或 HWND 数值择序，避免同面积重叠包装层随启动随机改变目标。默认仍为 `client`，兼容旧调用。它只投递窗口消息，不移动系统鼠标；屏幕坐标不赋予跨桌面权限。树超过 500 个子窗口、出现循环/跨树、点落在目标外或映射失败时拒绝操作。这是显式选择的投递方式，不是语义操作失败后的自动重试，文件结果仍需独立验证。

`hidden_screenshot(max_size=320)` 可按比例缩小输出。PrintWindow 返回成功仍不保证 GPU 画面可用，不自动把黑屏认定为应用出错。

`hidden_status` 提供依赖版本、暂停/忙碌状态、工作进程恢复代次与监督的进程记录，不持久化输入正文或命令行参数。进程句柄用于防止 PID 重用误判；释放前要求已记录进程退出且桌面无窗口。工作进程重建可恢复已确认进程的等待；整个 MCP 服务退出后记录不持久化，重新连接需重新观察，也不承诺发现全部子进程。每个隐藏服务额外使用一个按需启动的 Python 工作进程，以进程资源换取可恢复性，无新增第三方依赖。
