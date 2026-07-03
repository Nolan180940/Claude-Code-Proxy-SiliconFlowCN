const express = require('express');
const https = require('https');
const http = require('http');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ============ 多 Provider 配置 ============
// Provider 1: DeepSeek 官方 API（默认 / Sonnet 级）
// Provider 2: SiliconFlow（Opus → MiniMax-M2.5 / Haiku → GLM-5.2）
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    base: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
  },
  siliconflow: {
    name: 'SiliconFlow',
    base: 'https://api.siliconflow.cn',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    // 带图的请求用视觉模型
    visionModel: process.env.SILICONFLOW_VISION_MODEL || 'nex-agi/Nex-N2-Pro',
  },
};

// 模型映射：Anthropic 模型名 → { model, provider }
const MODEL_MAP = {
  'default': {
    model: process.env.DEEPSEEK_DEFAULT_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-sonnet-4-20250514': {
    model: process.env.DEEPSEEK_SONNET_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-3-5-sonnet-20241022': {
    model: process.env.DEEPSEEK_SONNET_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-opus-4-20250514': {
    model: process.env.DEEPSEEK_OPUS_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-opus-4-8': {
    model: process.env.DEEPSEEK_OPUS_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-3-opus-20240229': {
    model: process.env.DEEPSEEK_OPUS_MODEL || 'deepseek-v4-pro',
    provider: 'deepseek',
  },
  'claude-haiku-3-5-20241022': {
    model: process.env.SILICONFLOW_HAIKU_MODEL || 'zai-org/GLM-5.2',
    provider: 'siliconflow',
  },
};

function getModelConfig(anthropicModel) {
  return MODEL_MAP[anthropicModel] || MODEL_MAP['default'];
}

function getTargetModel(anthropicModel) {
  return getModelConfig(anthropicModel).model;
}

// ============ 图片检测 & 压缩 ============

/** 检测请求中是否包含图片（递归检查 tool_result 内部） */
function hasImages(anthropicBody) {
  if (!anthropicBody.messages) return false;
  for (const msg of anthropicBody.messages) {
    if (_checkBlocks(msg.content)) return true;
  }
  return false;
}
function _checkBlocks(blocks) {
  if (!blocks || !Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'image') return true;
    // 递归检查 tool_result 内部
    if (block.type === 'tool_result') {
      if (_checkBlocks(block.content)) return true;
    }
  }
  return false;
}

/** 压缩 base64 图片：缩小到 800px 宽，JPEG quality 60 */
async function compressImage(base64Data, mediaType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const compressed = await sharp(buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
    const newBase64 = compressed.toString('base64');
    console.log(`  Image compressed: ${(buffer.length/1024).toFixed(1)}KB → ${(compressed.length/1024).toFixed(1)}KB`);
    return { data: newBase64, mediaType: 'image/jpeg' };
  } catch (e) {
    console.error('  Image compression failed, using original:', e.message);
    return { data: base64Data, mediaType };
  }
}

/** 从 URL 下载图片并压缩，返回 base64 */
function downloadAndCompress(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向
        downloadAndCompress(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const compressed = await sharp(buffer)
            .resize({ width: 800, withoutEnlargement: true })
            .jpeg({ quality: 60 })
            .toBuffer();
          console.log(`  URL image compressed: ${(buffer.length/1024).toFixed(1)}KB → ${(compressed.length/1024).toFixed(1)}KB`);
          resolve({ data: compressed.toString('base64'), mediaType: 'image/jpeg' });
        } catch (e) {
          console.error('  URL image compression failed:', e.message);
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ============ Anthropic → OpenAI 请求转换（异步：压缩图片）============
async function convertRequest(anthropicBody, opts = {}) {
  const { compressImages = true, visionPrompt = '' } = opts;
  const messages = [];

  // Anthropic 的 system prompt 转为 OpenAI 的 system message
  if (visionPrompt) {
    messages.push({ role: 'system', content: visionPrompt });
  }
  if (anthropicBody.system) {
    const systemContent = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : (Array.isArray(anthropicBody.system) ? anthropicBody.system.map(b => b.text || '').join('\n') : '');
    if (systemContent) {
      const bgRule = '\n\n[CRITICAL RULE - ALWAYS FOLLOW]\n' +
        'When using Cua computer-use tools (mcp__cua-computer-use__*):\n' +
        '- ALWAYS use delivery_mode:"background" for click, type_text, scroll, press_key, hotkey, drag, and all input actions.\n' +
        '- NEVER use delivery_mode:"foreground" unless the user explicitly asks you to "bring this window to front" or "show me".\n' +
        '- NEVER call bring_to_front unless the user explicitly asks you to.\n' +
        '- The user is multitasking — do NOT steal focus or change their active window.\n' +
        '- Use launch_app WITHOUT bring_to_front for opening apps.\n';
      messages.push({ role: 'system', content: systemContent + bgRule });
    }
  }

  // 转换 messages
  if (anthropicBody.messages && Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      const openaiMsg = { role: msg.role, content: '' };

      if (typeof msg.content === 'string') {
        openaiMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Anthropic content blocks → OpenAI content
        const parts = [];
        for (const block of msg.content) {
          // 处理纯字符串（Claude Code 有时发字符串数组而非 content blocks）
          if (typeof block === 'string') {
            parts.push(block);
          } else if (block.type === 'text') {
            parts.push(block.text);
          } else if (block.type === 'image' && block.source) {
            // 图片压缩
            let imgData, imgType;
            if (block.source.type === 'url') {
              // URL 类型：下载 → 压缩 → base64
              if (compressImages) {
                try {
                  const compressed = await downloadAndCompress(block.source.url);
                  imgData = compressed.data;
                  imgType = compressed.mediaType;
                } catch (e) {
                  // 下载失败，直接用原始 URL
                  console.error('  URL download failed, using original URL:', e.message);
                  parts.push({
                    type: 'image_url',
                    image_url: { url: block.source.url }
                  });
                  continue;
                }
              } else {
                // 不压缩，直接用原始 URL
                parts.push({
                  type: 'image_url',
                  image_url: { url: block.source.url }
                });
                continue;
              }
            } else {
              // base64 类型
              imgData = block.source.data;
              imgType = block.source.media_type;
              if (compressImages) {
                const compressed = await compressImage(imgData, imgType);
                imgData = compressed.data;
                imgType = compressed.mediaType;
              }
            }
            // 图片块转为 OpenAI vision 格式
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${imgType};base64,${imgData}`
              }
            });
          } else if (block.type === 'tool_use') {
            // 工具调用 → OpenAI tool_calls 格式
            openaiMsg.tool_calls = [{
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input)
              }
            }];
            openaiMsg.content = null;
          } else if (block.type === 'tool_result') {
            openaiMsg.role = 'tool';
            openaiMsg.tool_call_id = block.tool_use_id;
            const MAX_TOOL_RESULT = 4000;
            if (typeof block.content === 'string') {
              openaiMsg.content = block.content.length > MAX_TOOL_RESULT
                ? block.content.slice(0, MAX_TOOL_RESULT) + `\n... [truncated: ${block.content.length} → ${MAX_TOOL_RESULT} chars]`
                : block.content;
            } else if (Array.isArray(block.content)) {
              // 检查 tool_result 内部是否包含图片（如 CUA 截图）
              let hasToolImages = false;
              const textParts = [];
              for (const sub of block.content) {
                if (typeof sub === 'string') {
                  textParts.push(sub);
                } else if (sub && sub.type === 'image' && sub.source) {
                  hasToolImages = true;
                  // 提取图片：压缩后放到当前消息的 parts 中
                  let imgData, imgType;
                  if (sub.source.type === 'url') {
                    try {
                      const compressed = await downloadAndCompress(sub.source.url);
                      imgData = compressed.data; imgType = compressed.mediaType;
                    } catch (e) {
                      console.error('  Tool image URL download failed:', e.message);
                      continue;
                    }
                  } else {
                    imgData = sub.source.data;
                    imgType = sub.source.media_type;
                    if (compressImages) {
                      const compressed = await compressImage(imgData, imgType);
                      imgData = compressed.data; imgType = compressed.mediaType;
                    }
                  }
                  parts.push({
                    type: 'image_url',
                    image_url: { url: `data:${imgType};base64,${imgData}` }
                  });
                  console.log('  Extracted image from tool_result');
                } else if (sub && sub.type === 'text') {
                  textParts.push(sub.text);
                } else {
                  textParts.push(JSON.stringify(sub));
                }
              }
              const summary = textParts.join('\n');
              openaiMsg.content = hasToolImages
                ? `[Tool result with ${textParts.length > 0 ? 'text and ' : ''}image(s) captured]\n${summary}`.slice(0, MAX_TOOL_RESULT)
                : (summary.length > MAX_TOOL_RESULT
                    ? summary.slice(0, MAX_TOOL_RESULT) + `\n... [truncated]`
                    : summary);
            } else if (typeof block.content === 'object' && block.content !== null) {
              // 单个对象，检测是否是 image 类型
              if (block.content.type === 'image' && block.content.source) {
                let imgData = block.content.source.data;
                let imgType = block.content.source.media_type;
                if (compressImages) {
                  const compressed = await compressImage(imgData, imgType);
                  imgData = compressed.data; imgType = compressed.mediaType;
                }
                parts.push({
                  type: 'image_url',
                  image_url: { url: `data:${imgType};base64,${imgData}` }
                });
                openaiMsg.content = '[Tool result: image captured]';
                console.log('  Extracted single image from tool_result');
              } else {
                openaiMsg.content = JSON.stringify(block.content);
              }
            } else {
              openaiMsg.content = String(block.content);
            }
          }
        }
        if (parts.length > 0 && !openaiMsg.tool_calls) {
          // 全是字符串就拼接，否则保持数组（含图片等混合内容）
          const allStrings = parts.every(p => typeof p === 'string');
          openaiMsg.content = allStrings ? parts.join('\n') : parts;
        }
      }

      messages.push(openaiMsg);
    }
  }

  const openaiBody = {
    model: opts.targetModel || getTargetModel(anthropicBody.model),
    messages: messages,
    max_tokens: Math.min(anthropicBody.max_tokens || 4096, 8192),
    stream: !!anthropicBody.stream,
  };

  // 复制其他参数
  if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
  if (anthropicBody.top_k !== undefined) openaiBody.top_k = anthropicBody.top_k;

  // stop_sequences → stop（只传非空数组）
  if (anthropicBody.stop_sequences && Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }

  // tools 转换
  if (anthropicBody.tools && Array.isArray(anthropicBody.tools) && anthropicBody.tools.length > 0) {
    openaiBody.tools = anthropicBody.tools.map(t => {
      // 深拷贝 input_schema 并移除 $schema 字段
      const params = JSON.parse(JSON.stringify(t.input_schema || { type: 'object', properties: {} }));
      delete params.$schema;
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: params
        }
      };
    });

    // tool_choice 转换
    if (anthropicBody.tool_choice) {
      const tc = anthropicBody.tool_choice;
      if (typeof tc === 'string') {
        openaiBody.tool_choice = tc;
      } else if (tc.type === 'auto') {
        openaiBody.tool_choice = 'auto';
      } else if (tc.type === 'any') {
        openaiBody.tool_choice = 'required';
      } else if (tc.type === 'tool' && tc.name) {
        openaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
      }
    }
  }

  return openaiBody;
}

// ============ OpenAI → Anthropic 响应转换（非流式）============
function convertResponse(openaiBody, anthropicModel) {
  const choice = openaiBody.choices && openaiBody.choices[0];
  if (!choice) {
    return {
      id: openaiBody.id || 'msg_' + Date.now(),
      type: 'message',
      role: 'assistant',
      model: anthropicModel,
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    };
  }

  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: input
      });
    }
  }

  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
  else if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
  else if (choice.finish_reason === 'stop') stop_reason = 'end_turn';

  return {
    id: openaiBody.id || 'msg_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: anthropicModel,
    content: content,
    stop_reason: stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiBody.usage?.prompt_tokens || 0,
      output_tokens: openaiBody.usage?.completion_tokens || 0
    }
  };
}

// ============ OpenAI SSE → Anthropic SSE 流式转换 ============
function convertStreamChunk(openaiChunk, anthropicModel, messageId) {
  const choice = openaiChunk.choices && openaiChunk.choices[0];
  if (!choice) return null;

  const delta = choice.delta || {};
  const events = [];

  // DeepSeek 的 reasoning_content 和 content 都可能出现
  const textContent = delta.content || '';

  if (textContent) {
    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    });
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: textContent }
    });
  }

  // tool_calls
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.index !== undefined) {
        if (tc.function?.name) {
          events.push({
            type: 'content_block_start',
            index: tc.index,
            content_block: { type: 'tool_use', id: tc.id || '', name: tc.function.name, input: {} }
          });
        }
        if (tc.function?.arguments) {
          events.push({
            type: 'content_block_delta',
            index: tc.index,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
          });
        }
      }
    }
  }

  // usage
  const usage = openaiChunk.usage ? {
    input_tokens: openaiChunk.usage.prompt_tokens || 0,
    output_tokens: openaiChunk.usage.completion_tokens || 0
  } : null;

  // finish_reason
  let stop_reason = null;
  if (choice.finish_reason) {
    if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
    else if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';
    else if (choice.finish_reason === 'stop') stop_reason = 'end_turn';
  }

  return { events, usage, stop_reason, messageId };
}

// ============ HTTP 请求辅助函数 ============
function makeRequest(baseUrl, apiKey, options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path, baseUrl);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...options.headers
      }
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ============ 路由 ============

// 健康检查
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Claude Code → Multi-Provider Proxy',
    providers: Object.keys(PROVIDERS),
    default: MODEL_MAP['default'],
    models: Object.fromEntries(
      Object.entries(MODEL_MAP).filter(([k]) => k !== 'default').map(([k, v]) => [k, `${v.provider}:${v.model}`])
    )
  });
});

// /v1/messages - Anthropic Messages API
app.post('/v1/messages', async (req, res) => {
  const anthropicModel = req.body.model || 'claude-sonnet-4-20250514';
  const containsImages = hasImages(req.body);
  
  // 有图片时强制走硅基流动视觉模型
  let modelConfig, targetModel, provider;
  if (containsImages) {
    provider = PROVIDERS.siliconflow;
    targetModel = provider.visionModel;
    console.log(`\n🖼️  Images detected → routing to vision model: ${targetModel}`);
  } else {
    modelConfig = getModelConfig(anthropicModel);
    targetModel = modelConfig.model;
    provider = PROVIDERS[modelConfig.provider];
  }
  
  const isStream = req.body.stream === true;

  console.log(`\n=== [${new Date().toISOString()}] REQUEST ===`);
  console.log(`Anthropic model: ${anthropicModel}`);
  console.log(`Provider: ${provider.name} | Target: ${targetModel} | Has images: ${containsImages}`);
  console.log(`Stream: ${isStream}`);

  try {
    const visionPrompt = containsImages
      ? 'You are a computer-use agent with access to a screenshot of the current screen. Use the available tools to interact with the browser and complete the user\'s task. Look at the screenshot, decide what action to take next (click, type, scroll, etc.), then call the appropriate CUA tool. Keep actions in background mode. Do NOT just describe what you see — take action.'
      : '';

    // 视觉请求时裁剪历史：保留 system + 所有 user 消息 + 最后 N 条，去掉重复
    if (containsImages && req.body.messages) {
      const VISION_MAX_TAIL = 4;
      const systemMsgs = req.body.messages.filter(m => m.role === 'system');
      const otherMsgs = req.body.messages.filter(m => m.role !== 'system');
      // 保留第一条 user（任务起源）+ 最后一条 user（当前指令）+ 尾部最近几条
      const userMsgs = otherMsgs.filter(m => m.role === 'user');
      const keyUserMsgs = [];
      if (userMsgs.length === 1) {
        keyUserMsgs.push(userMsgs[0]);
      } else if (userMsgs.length > 1) {
        keyUserMsgs.push(userMsgs[0]);
        if (userMsgs[userMsgs.length - 1] !== userMsgs[0]) {
          keyUserMsgs.push(userMsgs[userMsgs.length - 1]);
        }
      }
      const tailMsgs = otherMsgs.slice(-VISION_MAX_TAIL);
      const seen = new Set();
      const trimmedOther = [];
      for (const m of [...keyUserMsgs, ...tailMsgs]) {
        const k = m.role + ':' + JSON.stringify(m).slice(0, 80);
        if (!seen.has(k)) { seen.add(k); trimmedOther.push(m); }
      }
      req.body.messages = [...systemMsgs, ...trimmedOther];
      console.log(`  Vision: trimmed messages ${otherMsgs.length} → ${trimmedOther.length} (all user msgs + tail kept)`);
      req.body.messages = [...systemMsgs, ...trimmedOther];
      // 保留 tools — 视觉模型需要它们来输出正确的 tool_use 格式
      console.log(`  Vision: trimmed messages ${otherMsgs.length} → ${trimmedOther.length} (tools kept)`);
    }

    const openaiBody = await convertRequest(req.body, { compressImages: containsImages, visionPrompt, targetModel });
    console.log(`Converted body keys: ${Object.keys(openaiBody).join(', ')}`);
    console.log(`model: ${openaiBody.model}`);
    console.log(`max_tokens: ${openaiBody.max_tokens}`);
    console.log(`messages count: ${openaiBody.messages.length}`);
    if (openaiBody.tools) console.log(`tools count: ${openaiBody.tools.length}`);
    if (openaiBody.tool_choice) console.log(`tool_choice: ${JSON.stringify(openaiBody.tool_choice)}`);
    if (openaiBody.stop) console.log(`stop: ${JSON.stringify(openaiBody.stop)}`);
    // 打印 Anthropic 原始 tool 结构
    if (req.body.tools && req.body.tools.length > 0) {
      console.log(`Anthropic first tool: ${JSON.stringify(req.body.tools[0]).substring(0, 500)}`);
      console.log(`Anthropic tool_choice: ${JSON.stringify(req.body.tool_choice)}`);
    }
    // 打印转换后的第一个 tool
    if (openaiBody.tools && openaiBody.tools.length > 0) {
      console.log(`OpenAI first tool: ${JSON.stringify(openaiBody.tools[0]).substring(0, 500)}`);
    }
    // 打印消息角色
    console.log(`Message roles: ${openaiBody.messages.map(m => m.role).join(', ')}`);
    // 打印完整 body 用于调试（截断）
    const debugBody = JSON.stringify(openaiBody);
    console.log(`Full body (first 2000 chars): ${debugBody.substring(0, 2000)}`);

    if (isStream) {
      // 流式请求
      const url = new URL('/v1/chat/completions', provider.base);
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
          'Accept': 'text/event-stream'
        }
      };

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const messageId = 'msg_' + Date.now();
      let buffer = '';
      let messageStarted = false;
      let startedBlockIndices = new Set();  // 追踪所有已开始的 content block index
      let resEnded = false;

      const safeWrite = (data) => {
        if (!resEnded) { res.write(data); }
      };

      const safeEnd = () => {
        if (!resEnded) { resEnded = true; res.end(); }
      };

      // 发送所有已开始 block 的 content_block_stop
      const stopAllBlocks = () => {
        for (const idx of startedBlockIndices) {
          safeWrite(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
        }
        startedBlockIndices.clear();
      };

      const sfReq = https.request(reqOptions, (sfRes) => {
        console.log(`SiliconFlow response status: ${sfRes.statusCode}`);

        if (sfRes.statusCode !== 200) {
          let errData = '';
          sfRes.on('data', chunk => errData += chunk);
          sfRes.on('end', () => {
            console.error('SiliconFlow error:', errData);
            try { res.status(sfRes.statusCode).json(JSON.parse(errData)); } catch (e) { res.status(sfRes.statusCode).json({ error: errData }); }
          });
          return;
        }

        sfRes.on('data', (chunk) => {
          if (resEnded) return;
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (resEnded) break;
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                stopAllBlocks();
                safeWrite(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                safeEnd();
                return;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices && parsed.choices[0];
                if (!choice) continue;

                const delta = choice.delta || {};

                if (!messageStarted) {
                  messageStarted = true;
                  safeWrite(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model: anthropicModel, content: [] } })}\n\n`);
                }

                if (delta.content) {
                  if (!startedBlockIndices.has(0)) {
                    startedBlockIndices.add(0);
                    safeWrite(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                  }
                  safeWrite(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })}\n\n`);
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.index !== undefined) {
                      if (tc.function?.name && !startedBlockIndices.has(tc.index)) {
                        startedBlockIndices.add(tc.index);
                        safeWrite(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: tc.index, content_block: { type: 'tool_use', id: tc.id || '', name: tc.function.name, input: {} } })}\n\n`);
                      }
                      if (tc.function?.arguments) {
                        safeWrite(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: tc.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } })}\n\n`);
                      }
                    }
                  }
                }

                if (choice.finish_reason) {
                  let stop_reason = 'end_turn';
                  if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
                  else if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use';

                  stopAllBlocks();

                  safeWrite(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stop_reason, stop_sequence: null }, usage: { output_tokens: parsed.usage?.completion_tokens || 0 } })}\n\n`);
                  safeWrite(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                  safeEnd();
                }
              } catch (e) {
                console.error('Parse error:', e.message);
              }
            }
          }
        });

        sfRes.on('end', () => {
          if (!resEnded) {
            stopAllBlocks();
            safeWrite(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            safeEnd();
          }
        });

        sfRes.on('error', (err) => {
          console.error('Stream error:', err.message);
          if (!resEnded) {
            safeWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
            safeEnd();
          }
        });
      });

      sfReq.on('timeout', () => { sfReq.destroy(); console.error('Request timeout'); });
      sfReq.on('error', (err) => {
        console.error('Request error:', err.message);
        if (!resEnded) {
          safeWrite(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
          safeEnd();
        }
      });

      sfReq.write(JSON.stringify(openaiBody));
      sfReq.end();

    } else {
      // 非流式请求
      const result = await makeRequest(
        provider.base, provider.apiKey,
        { method: 'POST', path: '/v1/chat/completions' },
        openaiBody
      );

      if (result.status !== 200) {
        console.error('API error body:', JSON.stringify(result.body).substring(0, 500));
        return res.status(result.status).json(result.body);
      }

      const anthropicResponse = convertResponse(result.body, anthropicModel);
      console.log(`Response OK, content blocks: ${anthropicResponse.content.length}`);
      res.json(anthropicResponse);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// /v1/models - 返回可用模型列表
app.get('/v1/models', (req, res) => {
  res.json({
    data: Object.keys(MODEL_MAP).filter(k => k !== 'default').map(id => ({
      id: id,
      object: 'model',
      created: 1,
      owned_by: 'anthropic'
    }))
  });
});

// ============ 启动服务器 ============
const PORT = process.env.PORT || 8787;

const server = app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Claude Code → Multi-Provider Proxy`);
  console.log(`  Listening: http://127.0.0.1:${PORT}`);
  console.log(`  Default/Sonnet: [deepseek] ${MODEL_MAP['default'].model}`);
  console.log(`  Opus:           [deepseek] ${MODEL_MAP['claude-opus-4-20250514'].model}`);
  console.log(`  Haiku:          [siliconflow] ${MODEL_MAP['claude-haiku-3-5-20241022'].model}`);
  console.log(`========================================\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] 端口 ${PORT} 已被占用！`);
    console.error('请先关闭占用该端口的程序。');
    console.error('运行: netstat -ano | findstr :8787 查看占用进程');
    process.exit(1);
  } else {
    throw err;
  }
});
