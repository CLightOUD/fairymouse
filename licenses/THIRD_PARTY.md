# 第三方来源

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
- 只保留原始 `src/lowlevel_computer_use_mcp/winio.py`，位于 `../hidden/vendor/winio.py`。
- 上游 pyproject.toml 声明 MIT 许可证；原始声明保留在 `lowlevel-pyproject.toml`。
- 不部署该项目的安装器、完整服务、HTTP 入口或系统管理工具。

## 运行时依赖

Python 来自 uv 使用的 python-build-standalone CPython 3.12.13 Windows x64 发行版；许可证保留在安装目录 `python/LICENSE.txt`。
Python 包按 `requirements.lock` 安装，其原有许可证和发行元数据保留在 `runtime/Lib/site-packages`。
