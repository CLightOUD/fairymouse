# 第三方来源

Fairymouse 原创代码采用 GPL-3.0-only，完整文本见 [LICENSE](../LICENSE)。下列第三方代码保留其原有许可；根目录许可证不替代这些声明。

## agent-desktop

- 来源：https://github.com/vercel-labs/agent-desktop
- 版本：v1.2.0；提交 `2b0a7334fc111730454b726e6800aa41cdafc093`
- 许可证：Apache-2.0，原文见 `agent-desktop-APACHE-2.0.txt`。
- 本地改动：关闭 UIA AutoSetFocus；MCP 子进程使用 CREATE_NO_WINDOW；新增对应回归检查。
- 完整本地补丁：`../patches/agent-desktop-1.2.0.patch`。
- 执行文件 SHA256：`7C5428937F24B090F1184B41900043A2B855C3F9F6474D879B12D2B6D43C153A`。

## lowlevel-computer-use-mcp 的 winio 后端

- 来源：https://github.com/codingmachineedge/lowlevel-computer-use-mcp
- 版本：0.1.0；提交 `ae648ae6c994e8135c874cc895291896f60b8c19`。
- 基于原始 `src/lowlevel_computer_use_mcp/winio.py`，位于 `../hidden/vendor/winio.py`。
- 本地修复：限时文字消息、消息投递错误与回读结果、控件客户区坐标与 ID、限制作用域内跨桌面回退、GDI 清理、指针宽度声明、进程句柄跟踪及桌面释放结果检查。修改历史由本地 Git 保留。
- 上游 pyproject.toml 声明 MIT 许可证；原始声明保留在 `lowlevel-pyproject.toml`。
- 固定提交的仓库根目录未提供独立 LICENSE 文件；保留其明确的 MIT 声明，标准许可条文另附 `lowlevel-MIT.txt`，不补写上游未提供的版权年份或作者声明。
- 不部署该项目的安装器、完整服务、HTTP 入口或系统管理工具。

## 运行时依赖

Python 来自 uv 使用的 python-build-standalone CPython 3.12.13 Windows x64 发行版；许可证随发行版保留在本地 Python 安装目录中，具体位置取决于安装脚本复用 `python/` 还是下载至 `python-managed/`。
Python 包按 `requirements.lock` 安装，其原有许可证和发行元数据保留在 `runtime/Lib/site-packages`。

## 许可文本来源

- GPL-3.0-only 全文：[SPDX 标准文本](https://github.com/spdx/license-list-data/blob/main/text/GPL-3.0-only.txt)。项目指定使用第 3 版，不包含“或任意后续版本”的额外授权。
- MIT 标准条文：[SPDX 标准文本](https://github.com/spdx/license-list-data/blob/main/text/MIT.txt)。上游许可选择依据上述固定版本的 `pyproject.toml`。
