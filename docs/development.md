# 重建与维护

[返回项目首页](../README.md)

## Python 环境

通常只需在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
node scripts/doctor.mjs
```

安装脚本使用 uv 管理的 CPython 3.12.13 Windows x64，并优先复用符合版本要求的项目内环境。`python-managed/`、`python/` 和 `runtime/` 均为本地安装内容，不进入 Git。完整依赖见 [requirements.lock](../requirements.lock)，直接依赖见 [requirements.in](../requirements.in)。

已有正确版本的 `runtime` 环境时，可直接同步锁定依赖：

```powershell
uv pip sync --python runtime/Scripts/python.exe requirements.lock
```

修改依赖时同时更新直接依赖与锁定文件，运行安装诊断和相关回归，不以删除必需的传递依赖压缩体积。

## 原生 UIA 后端

仓库携带的 Windows x64 `desktop/agent-desktop.exe` 基于 [agent-desktop](https://github.com/vercel-labs/agent-desktop) v1.2.0，固定提交为 `2b0a7334fc111730454b726e6800aa41cdafc093`。本地补丁关闭 UIA 自动聚焦，并让 MCP 派生进程使用 `CREATE_NO_WINDOW`。来源、许可证和当前二进制 SHA256 见 [第三方来源](../licenses/THIRD_PARTY.md)。

重建需要 Rust（该上游版本要求至少 1.89）、MSVC C++ 构建工具与 Windows SDK；这些工具只用于开发，不是 Fairymouse 运行依赖。在另选的源码目录执行：

```powershell
git clone https://github.com/vercel-labs/agent-desktop.git
cd agent-desktop
git checkout 2b0a7334fc111730454b726e6800aa41cdafc093
# 将下面路径替换为本地 Fairymouse 补丁的绝对路径
git apply C:/path/to/fairymouse/patches/agent-desktop-1.2.0.patch
cargo build --locked --release -p agent-desktop
```

输出位于 `target/release/agent-desktop.exe`。替换 Fairymouse 后端前检查补丁已应用，重新核对自动聚焦行为，运行 `tests/run.ps1`，并更新第三方记录中的 SHA256。不同编译器和构建环境可能产生不同的文件哈希；哈希变化本身不能证明补丁正确。

## 提交范围

- 提交源码、锁定依赖、必要补丁、许可证和可复核的小型测试报告。
- 不提交运行时、缓存、编译测试程序、账号配置、截图或个人录屏。
- 修改原生调用、超时、引用、协议或运行入口时，运行 `tests/run.ps1`；真实应用行为变更再运行对应应用回归。
- 文档修改只检查文档与命令，不因此启动整套真实应用测试。

现有报告是历史测试证据，不能替代新机器、新版本或新改动的验证。应用跳过、结果未知和采样异常均应保留并说明。
