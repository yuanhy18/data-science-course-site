const config = window.COURSE_AGENT_CONFIG || {};
const apiBaseUrl = String(config.apiBaseUrl || '').replace(/\/$/, '');
const healthPath = config.healthPath || '/health';
const chatPath = config.chatPath || '/api/chat';
const timeoutMs = Number(config.timeoutMs) || 10000;

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

function addMessage(text, type, meta = '') {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${type === 'user' ? 'user-message' : 'assistant-message'}`;

  const content = document.createElement('div');
  content.textContent = text;
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
  submitButton.textContent = busy ? '连接中…' : '发送测试';
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

async function answerQuestion(question) {
  addMessage(question, 'user');
  const waitingMessage = addMessage('正在等待学生云服务器响应……', 'assistant');

  if (!validateConfig()) {
    waitingMessage.firstChild.textContent =
      '测试接口尚未配置。请学生先在 agent-config.js 中填写云平台分配的HTTPS测试地址。';
    return;
  }

  setBusy(true);
  try {
    const data = await requestJson(chatPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question })
    });

    waitingMessage.firstChild.textContent = data.answer || '服务器已响应，但没有返回answer字段。';
    const meta = document.createElement('small');
    meta.className = 'message-meta';
    meta.textContent = `联调编号：${data.request_id || '未返回'} · 模式：${data.mode || 'fixed'}`;
    waitingMessage.appendChild(meta);
    requestIdText.textContent = data.request_id || '未返回';
    serverTimeText.textContent = data.server_time || '未返回';
    setStatus('online', '最近一次文本联调成功');
  } catch (error) {
    console.error('Course agent API request failed:', error);
    waitingMessage.firstChild.textContent =
      '测试服务器没有正常响应。课程主页仍可使用，请学生检查API网关、服务器进程和浏览器控制台。';
    setStatus('error', error.name === 'AbortError' ? '请求超时' : '文本联调失败');
  } finally {
    setBusy(false);
    chatInput.focus();
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
  addMessage(
    '你好！这里是课程智能体独立测试页。第一阶段只验证文字能否到达学生云服务器并返回，不会调用大模型。',
    'assistant'
  );
  resetMeta();
});

testPromptButton.addEventListener('click', () => {
  const randomCode = Math.random().toString(36).slice(2, 6).toUpperCase();
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  chatInput.value = `第一阶段联调验证-${month}${day}-${randomCode}`;
  chatInput.focus();
});

checkHealth();
