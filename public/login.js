const password = document.querySelector('#password');
document.querySelector('#toggle').addEventListener('click', event => {
  const shown = password.type === 'password'; password.type = shown ? 'text' : 'password';
  const button = event.currentTarget; button.classList.toggle('revealed', shown);
  button.setAttribute('aria-label', shown ? '隐藏管理员密码' : '显示管理员密码'); button.setAttribute('aria-pressed', String(shown));
});
document.querySelector('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const message = document.querySelector('#message'); message.textContent = '正在登录…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }), cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error.message);
    password.value = ''; location.replace('/admin');
  } catch (error) { message.textContent = error.message || '网络连接失败，请重试'; }
  finally { button.disabled = false; }
});
