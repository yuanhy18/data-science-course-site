const menuButton = document.querySelector('.menu-button');
const navigation = document.querySelector('.main-nav');
const chatMessages = document.querySelector('#chat-messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const resetButton = document.querySelector('#reset-chat');

const demoReplies = {
  '什么是训练集和测试集？': '训练集用于让模型学习规律，测试集用于评价模型面对未见数据时的表现。关键点是：测试集不能参与训练或调参。建议复习“机器学习基础”模块，并进一步思考验证集的作用。',
  '如何检查缺失值？': '可以先用 pandas 的 df.isna().sum() 统计每列缺失数量，再计算缺失比例并观察缺失是否具有规律。不要立即删除：应结合变量含义、缺失机制和分析目标决定处理方法。',
  '聚类前为什么要标准化？': '常见聚类算法依赖距离。如果不同变量的量纲差异很大，数值范围大的变量会主导距离。标准化能让各特征处在可比较尺度，但仍需检查异常值和变量业务意义。'
};

function addMessage(text, type) {
  const message = document.createElement('div');
  message.className = `message ${type === 'user' ? 'user-message' : 'assistant-message'}`;
  message.textContent = text;
  chatMessages.appendChild(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function answerQuestion(question) {
  addMessage(question, 'user');
  const reply = demoReplies[question] || '这是一个前端演示页面，目前尚未连接真实大模型。正式版本将从课程知识库检索相关内容、标注资料出处，并在不确定时提示你进一步核验。';
  window.setTimeout(() => addMessage(reply, 'assistant'), 250);
}

document.querySelectorAll('[data-question]').forEach((button) => {
  button.addEventListener('click', () => answerQuestion(button.dataset.question));
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  answerQuestion(question);
  chatInput.value = '';
});

resetButton.addEventListener('click', () => {
  chatMessages.innerHTML = '<div class="message assistant-message">你好！我是课程智能体样例。你可以点击下方问题，体验未来的答疑方式。</div>';
});

menuButton.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

navigation.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    navigation.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  });
});
