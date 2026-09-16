// 本文件只保存公开的测试接口地址，绝不能填写密码、Token或模型API Key。
// 学生完成云端测试入口后，把 apiBaseUrl 替换为云平台分配的HTTPS测试地址。
window.COURSE_AGENT_CONFIG = {
  // 原有后端配置（保留兼容）
  apiBaseUrl: 'http://124.221.169.198',
  healthPath: '/health',
  chatPath: '/api/chat',
  timeoutMs: 30000,

  // DeepSeek API 配置
  deepseek: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    systemPrompt: '你是「数据科学与数据分析」课程的智能学习助手，名为「财数学习助手」。你精通数据科学、统计学、Python数据分析、机器学习基础等领域的知识。请用中文回答，语言清晰易懂，适合大学生理解。回答时尽量结合课程知识点，给出有深度的解答。'
  }
};
