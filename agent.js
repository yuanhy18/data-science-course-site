const config = window.COURSE_AGENT_CONFIG || {};
const apiBaseUrl = String(config.apiBaseUrl || '').replace(/\/$/, '');
const healthPath = config.healthPath || '/health';
const chatPath = config.chatPath || '/api/chat';
const timeoutMs = Number(config.timeoutMs) || 30000;

// DeepSeek 配置
const dsConfig = config.deepseek || {};
const dsEnabled = dsConfig.enabled === true;
const dsApiKey = dsConfig.apiKey || '';
const dsBaseUrl = String(dsConfig.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
const dsModel = dsConfig.model || 'deepseek-chat';
const dsSystemPrompt = dsConfig.systemPrompt || '你是课程智能学习助手。';

const chatMessages = document.querySelector('#chat-messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const submitButton = document.querySelector('#chat-submit');
const resetButton = document.querySelector('#reset-chat');
const statusDot = document.querySelector('#api-status-dot');
const statusText = document.querySelector('#api-status-text');
const endpointText = document.querySelector('#endpoint-text');
const requestIdText = document.querySelector('#request-id-text');
const serverTimeText = document.querySelector('#server-time-text');
const testPromptButton = document.querySelector('#create-test-prompt');

// 对话历史（用于多轮对话）
let conversationHistory = [];

// ===== Markdown 转 HTML 解析器 =====
function parseMarkdown(text) {
  if (!text) return '';

  // 先转义 HTML 特殊字符，防止 XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 收集 LaTeX 公式，用占位符替换，避免被后续处理破坏
  const latexBlocks = [];
  html = html.replace(/\\\[([\s\S]*?)\\\]/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'block', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });
  html = html.replace(/\\\((.+?)\\\)/g, function(match, formula) {
    const id = latexBlocks.length;
    latexBlocks.push({ type: 'inline', content: formula.trim() });
    return '<!--LATEX:' + id + '-->';
  });

  // 收集 mermaid 图表，用占位符替换，避免被后续处理破坏
  const mermaidBlocks = [];
  html = html.replace(/```mermaid\n?([\s\S]*?)```/g, function(match, code) {
    const id = 'mermaid-' + mermaidBlocks.length;
    mermaidBlocks.push(code.trim());
    return '<!--MERMAID:' + id + '-->';
  });

  // 处理代码块（```...```）
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function(match, lang, code) {
    const escapedCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<pre><code class="language-' + (lang || 'plaintext') + '">' + escapedCode + '</code></pre>';
  });

  // 处理行内代码（`...`）
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 处理标题（### ...）
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 处理粗体+斜体（***...***）
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // 处理粗体（**...**）
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 处理斜体（*...*），但不匹配列表项开头的 *
  html = html.replace(/(^|[^*])\*([^*\n]+?)\*($|[^*])/gm, '$1<em>$2</em>$3');

  // 处理无序列表（- 或 * 开头）
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // 处理有序列表（1. 2. 等）
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, function(match) {
    if (!match.startsWith('<ul>')) {
      return '<ol>' + match + '</ol>';
    }
    return match;
  });

  // 处理水平线（但不匹配表格分隔行）
  html = html.replace(/^---$/gm, '<hr>');

  // 处理 Markdown 表格
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, function(tableBlock) {
    const rows = tableBlock.trim().split('\n');
    if (rows.length < 2) return tableBlock;
    if (!/^\|[\s\-:|]+\|$/.test(rows[1].trim())) return tableBlock;

    let tableHtml = '<table>';
    tableHtml += '<thead><tr>';
    const headers = rows[0].split('|').filter(c => c.trim() !== '');
    for (const h of headers) {
      tableHtml += '<th>' + h.trim() + '</th>';
    }
    tableHtml += '</tr></thead>';

    tableHtml += '<tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = rows[i].split('|').filter(c => c.trim() !== '');
      if (cells.length === 0) continue;
      tableHtml += '<tr>';
      for (const c of cells) {
        tableHtml += '<td>' + c.trim() + '</td>';
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';
    return tableHtml;
  });

  // 处理段落：将连续的非空行包裹在 <p> 中
  const lines = html.split('\n');
  const result = [];
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      result.push('<p>' + paragraph.join('\n') + '</p>');
      paragraph = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^<(h[1-4]|ul|ol|li|pre|hr|blockquote|table|\/ul|\/ol|\/pre)/.test(line.trim())) {
      flushParagraph();
      result.push(line);
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();

  let output = result.join('\n');

  // 将 Mermaid 占位符替换为图表容器
  for (let i = 0; i < mermaidBlocks.length; i++) {
    const escapedCode = mermaidBlocks[i]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    output = output.replace(
      '<!--MERMAID:mermaid-' + i + '-->',
      '<div class="mermaid">' + escapedCode + '</div>'
    );
  }

  // 将 LaTeX 占位符替换为 KaTeX 可渲染的容器
  for (let i = 0; i < latexBlocks.length; i++) {
    const block = latexBlocks[i];
    const escapedFormula = block.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    if (block.type === 'block') {
      output = output.replace(
        '<!--LATEX:' + i + '-->',
        '<div class="math-block">\\[' + escapedFormula + '\\]</div>'
      );
    } else {
      output = output.replace(
        '<!--LATEX:' + i + '-->',
        '<span class="math-inline">\\( ' + escapedFormula + ' \\)</span>'
      );
    }
  }

  return output;
}

function addMessage(text, type, meta = '', useMarkdown = false) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${type === 'user' ? 'user-message' : 'assistant-message'}`;

  const content = document.createElement('div');
  content.className = 'message-content';

  if (useMarkdown && type === 'assistant') {
    content.innerHTML = parseMarkdown(text);
  } else {
    content.textContent = text;
  }

  wrapper.appendChild(content);

  if (meta) {
    const metaLine = document.createElement('small');
    metaLine.className = 'message-meta';
    metaLine.textContent = meta;
    wrapper.appendChild(metaLine);
  }

  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return wrapper;
}

function setStatus(state, text) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
}

function setBusy(busy) {
  submitButton.disabled = busy;
  chatInput.disabled = busy;
  submitButton.textContent = busy ? '思考中…' : '发送';
}

function resetMeta() {
  requestIdText.textContent = '尚无请求';
  serverTimeText.textContent = '尚无响应';
}

function getEndpoint(path) {
  return `${apiBaseUrl}${path}`;
}

function isLivePage() {
  return window.location.protocol === 'https:';
}

function validateConfig() {
  if (dsEnabled) {
    if (!dsApiKey || dsApiKey === 'YOUR_DEEPSEEK_API_KEY_HERE') {
      setStatus('waiting', '请先在 agent-config.js 中填入 DeepSeek API Key');
      endpointText.textContent = 'DeepSeek API';
      return false;
    }
    endpointText.textContent = `${dsModel} @ DeepSeek`;
    return true;
  }

  if (!apiBaseUrl) {
    setStatus('waiting', '等待学生配置服务器入口');
    endpointText.textContent = '尚未配置';
    return false;
  }

  if (isLivePage() && !apiBaseUrl.startsWith('https://')) {
    setStatus('error', '线上页面只能连接HTTPS接口');
    endpointText.textContent = apiBaseUrl;
    return false;
  }

  endpointText.textContent = apiBaseUrl;
  return true;
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(getEndpoint(path), {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function checkHealth() {
  if (dsEnabled) {
    if (!dsApiKey || dsApiKey === 'YOUR_DEEPSEEK_API_KEY_HERE') {
      setStatus('waiting', '等待填入 DeepSeek API Key');
      endpointText.textContent = 'DeepSeek API';
      return;
    }
    setStatus('online', `DeepSeek · ${dsModel}`);
    endpointText.textContent = `${dsModel} @ DeepSeek`;
    return;
  }

  if (!validateConfig()) return;

  setStatus('checking', '正在检查测试服务器');
  try {
    const data = await requestJson(healthPath);
    if (data.status !== 'ok') throw new Error('Unexpected health response');
    setStatus('online', `测试服务器在线 · ${data.version || 'phase-1'}`);
  } catch (error) {
    console.error('Course agent health check failed:', error);
    setStatus('error', '测试服务器暂时不可用');
  }
}

async function callDeepSeek(messages) {
  const response = await fetch(`${dsBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dsApiKey}`
    },
    body: JSON.stringify({
      model: dsModel,
      messages: messages,
      temperature: 0.7,
      max_tokens: 2000
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 返回错误 (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data;
}

async function answerQuestion(question) {
  addMessage(question, 'user');
  const waitingMessage = addMessage('正在思考……', 'assistant');

  if (!validateConfig()) {
    waitingMessage.querySelector('.message-content').textContent =
      'DeepSeek API Key 尚未配置。请在 agent-config.js 中将 YOUR_DEEPSEEK_API_KEY_HERE 替换为您的真实 API Key。';
    return;
  }

  setBusy(true);

  if (dsEnabled) {
    try {
      const messages = [
        { role: 'system', content: dsSystemPrompt }
      ];

      const recentHistory = conversationHistory.slice(-20);
      for (const item of recentHistory) {
        messages.push({ role: item.role, content: item.content });
      }

      messages.push({ role: 'user', content: question });

      const data = await callDeepSeek(messages);

      const reply = data.choices?.[0]?.message?.content || 'DeepSeek 未返回有效回复。';
      const usage = data.usage || {};
      const requestId = data.id || '未返回';

      // 使用 Markdown 渲染
      waitingMessage.querySelector('.message-content').innerHTML = parseMarkdown(reply);

      // 渲染 Mermaid 图表
      try {
        await mermaid.run({ querySelector: '.mermaid' });
      } catch (e) {
        console.warn('Mermaid 渲染失败:', e.message);
      }

      // 渲染 KaTeX 数学公式
      try {
        renderMathInElement(waitingMessage.querySelector('.message-content'), {
          delimiters: [
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false,
          strict: false
        });
      } catch (e) {
        console.warn('KaTeX 渲染失败:', e.message);
      }

      const meta = document.createElement('small');
      meta.className = 'message-meta';
      meta.textContent = `模型：${dsModel} · tokens：${usage.total_tokens || '?'} · ID：${requestId}`;
      waitingMessage.appendChild(meta);

      conversationHistory.push({ role: 'user', content: question });
      conversationHistory.push({ role: 'assistant', content: reply });

      requestIdText.textContent = requestId;
      serverTimeText.textContent = new Date().toLocaleString('zh-CN');
      setStatus('online', `DeepSeek · ${dsModel}`);
    } catch (error) {
      console.error('DeepSeek API request failed:', error);
      waitingMessage.querySelector('.message-content').textContent =
        `DeepSeek 请求失败：${error.message}。请检查 API Key 是否正确、网络是否通畅。`;
      setStatus('error', error.name === 'TimeoutError' ? '请求超时' : 'API 调用失败');
    } finally {
      setBusy(false);
      chatInput.focus();
    }
  } else {
    try {
      const data = await requestJson(chatPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question })
      });

      waitingMessage.querySelector('.message-content').textContent = data.answer || '服务器已响应，但没有返回answer字段。';
      const meta = document.createElement('small');
      meta.className = 'message-meta';
      meta.textContent = `联调编号：${data.request_id || '未返回'} · 模式：${data.mode || 'fixed'}`;
      waitingMessage.appendChild(meta);
      requestIdText.textContent = data.request_id || '未返回';
      serverTimeText.textContent = data.server_time || '未返回';
      setStatus('online', '最近一次文本联调成功');
    } catch (error) {
      console.error('Course agent API request failed:', error);
      waitingMessage.querySelector('.message-content').textContent =
        '测试服务器没有正常响应。课程主页仍可使用，请学生检查API网关、服务器进程和浏览器控制台。';
      setStatus('error', error.name === 'AbortError' ? '请求超时' : '文本联调失败');
    } finally {
      setBusy(false);
      chatInput.focus();
    }
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  answerQuestion(question);
  chatInput.value = '';
});

resetButton.addEventListener('click', () => {
  chatMessages.innerHTML = '';
  conversationHistory = [];
  addMessage(
    '你好！我是财数学习助手，已接入 DeepSeek 大模型。你可以向我提问数据科学、统计分析、Python 编程等课程相关问题。',
    'assistant'
  );
  resetMeta();
});

testPromptButton.addEventListener('click', () => {
  const prompts = [
    '请解释什么是标准差，并举例说明它在数据分析中的作用。',
    'Python 中 Pandas 和 NumPy 的主要区别是什么？',
    '什么是线性回归？请用通俗的语言解释。',
    '数据清洗通常包含哪些步骤？'
  ];
  const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];
  chatInput.value = randomPrompt;
  chatInput.focus();
});

checkHealth();
