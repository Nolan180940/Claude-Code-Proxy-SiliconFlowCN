# Claude Code → SiliconFlow Proxy

一个轻量级 API 代理，将 Anthropic Messages API 请求转换为 SiliconFlow（硅基流动）OpenAI 兼容 API，让你用国产大模型驱动 Claude Code。

## 🎯 工作原理

```
Claude Code ──Anthropic API──▶ Proxy (localhost:8787) ──OpenAI API──▶ SiliconFlow
                    ◀── Anthropic SSE ──               ◀── OpenAI SSE ──
```

代理在本地运行，实时转换：
- **请求方向**：Anthropic Messages API → OpenAI Chat Completions API
- **响应方向**：OpenAI 响应 → Anthropic 格式（含流式 SSE）
- **模型映射**：Claude 模型名 → SiliconFlow 上的任意模型

## 🚀 快速开始

### 1. 获取 API Key

在 [SiliconFlow](https://cloud.siliconflow.cn) 注册并获取 API Key。

### 2. 配置环境变量

复制示例文件并填入你的 Key：

```bash
cp .env.example .env
# 编辑 .env，填入 SILICONFLOW_API_KEY=sk-xxx
```

或者直接设置环境变量：

**Windows (PowerShell):**
```powershell
$env:SILICONFLOW_API_KEY="sk-your-key-here"
```

**macOS / Linux:**
```bash
export SILICONFLOW_API_KEY="sk-your-key-here"
```

### 3. 安装依赖 & 启动代理

```bash
npm install
node server.js
```

代理默认运行在 `http://127.0.0.1:8787`。

### 4. 启动 Claude Code

```bash
# 设置 Claude Code 使用本地代理
set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
set ANTHROPIC_API_KEY=sk-siliconflow-proxy

# 启动（--bare 跳过 OAuth 登录）
claude --bare
```

或直接使用提供的启动脚本（Windows）：
```bash
# 复制模板并填入你的 Key
copy start-claude.bat.example start-claude.bat
# 编辑 start-claude.bat，替换 API Key
start-claude.bat
```

## ⚙️ 配置选项

所有配置通过环境变量设置：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `SILICONFLOW_API_KEY` | SiliconFlow API Key（**必填**） | - |
| `SILICONFLOW_DEFAULT_MODEL` | 默认模型 | `deepseek-ai/DeepSeek-V4-Pro` |
| `SILICONFLOW_SONNET_MODEL` | Sonnet 级模型 | 同上 |
| `SILICONFLOW_OPUS_MODEL` | Opus 级模型 | 同上 |
| `SILICONFLOW_HAIKU_MODEL` | Haiku 级模型 | 同上 |
| `PORT` | 代理监听端口 | `8787` |

### 模型映射

Claude Code 请求的 Anthropic 模型名会自动映射到 SiliconFlow 模型：

| Claude 模型 | 默认映射到 |
|------------|----------|
| `claude-sonnet-4-20250514` | `deepseek-ai/DeepSeek-V4-Pro` |
| `claude-opus-4-20250514` | `deepseek-ai/DeepSeek-V4-Pro` |
| `claude-haiku-3-5-20241022` | `deepseek-ai/DeepSeek-V4-Pro` |
| 其他未匹配模型 | `deepseek-ai/DeepSeek-V4-Pro` |

你可以通过环境变量将不同级别的 Claude 模型映射到 SiliconFlow 上的不同模型。

## 📡 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查 & 当前配置 |
| `/v1/messages` | POST | Anthropic Messages API（核心端点） |
| `/v1/models` | GET | 可用模型列表 |

## 🛠 技术细节

- **请求转换**：system prompt → system message，content blocks → OpenAI content，tools → OpenAI functions
- **流式转换**：OpenAI SSE → Anthropic SSE events（`message_start`、`content_block_start`、`content_block_delta`、`message_delta`、`message_stop`）
- **工具调用**：完整支持 tool_use / tool_result 双向转换
- **图片支持**：支持 Anthropic vision 格式的图片块转换

## 📄 许可

MIT License

## ⚠️ 免责声明

本项目仅供学习和研究使用。使用第三方 API 服务时请遵守相关服务条款。
