import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function reject(message) {
  console.error(`发布已阻止：${message}`);
  process.exit(1);
}

if (process.env.VERISCOPE_RELEASE !== '1') {
  reject('仅允许显式授权发布；请在完整源码仓库设置 VERISCOPE_RELEASE=1 后重试。');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const options = { cwd: root, encoding: 'utf8', windowsHide: true };
const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], options);
if (repository.error || repository.status !== 0) {
  reject('无法核对 Git 源码仓库；请确认 Git 可用，并从完整仓库发布。');
}

const tag = spawnSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], options);
if (tag.error || (tag.status !== 0 && tag.status !== 128)) {
  reject('无法读取当前提交的精确 tag。');
}
if (tag.status === 128) {
  console.warn('警告：当前提交没有精确 tag；已显式设置 VERISCOPE_RELEASE=1，本地守卫按约定放行，便于打 tag 前预检。正式 CI 另行强制校验 tag 与版本。');
} else if (tag.stdout.trim() !== `v${version}`) {
  reject(`当前 tag ${tag.stdout.trim()} 与 package.json 版本 ${version} 不一致。`);
}

console.log(`发布守卫通过：dsh-plugin-veriscope@${version}。`);
