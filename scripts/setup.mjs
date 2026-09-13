import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const password = randomBytes(18).toString('base64url');
try {
  await writeFile('.dev.vars', `ADMIN_PASSWORD="${password}"\nMASTER_KEY="${randomBytes(32).toString('base64')}"\n`, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .dev.vars（已被 Git 忽略）。请在本机打开该文件查看管理员密码。不要公开或提交此文件。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.dev.vars 已存在，未覆盖。');
}
