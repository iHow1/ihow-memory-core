// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Reproduce the SEMANTIC_RECALL_FLOORS calibration (src/engine/retrieval.ts). The C3 lexical-gate bypass
// only fires above a PER-MODEL cosine floor with measured separation between related and off-topic pairs —
// "nearest" ≠ "relevant", so an unfloored bypass re-opens the off-topic injection harm-eval closed.
// Re-run this when adding a model to the table or when a model version drifts:
//
//   node scripts/calibrate-semantic-floor.mjs [model] [host]
//   # defaults: bge-m3  http://127.0.0.1:11434   (use 127.0.0.1, NOT localhost — Docker Desktop
//   # publishes its own model runner on IPv6 *:11434 and localhost may resolve to ::1)
//
// 2026-07-01 result (bge-m3, 18 related / 144 off-topic ZH-heavy pairs): floor 0.58 → 0 off-topic pairs
// leak, 15/18 paraphrases rescued; hardest negative 0.575 (nginx↔pnpm). nomic-embed-text measured
// NON-separating on short CJK (off-topic up to 0.79, ABOVE most true positives; prefixes don't fix it)
// → deliberately absent from the floor table.

const model = process.argv[2] || 'bge-m3';
const host = process.argv[3] || 'http://127.0.0.1:11434';

const DOCS = {
  pnpm: '偏好：仓库里统一用 pnpm 装依赖。',
  pg: 'Postgres 连接池上限 20，配置在 configs/db.yaml。',
  palette: '仪表盘配色统一用低饱和度冷色调。',
  deploy: '发布流程：先跑预检脚本，再灰度 5% 观察半小时。',
  font: '中文图表字体优先用鸿蒙 Sans，回退苹方。',
  port: '本地控制台跑在 8788 端口，只绑 127.0.0.1。',
  meeting: '周会改到每周四上午十点，线上腾讯会议。',
  backup: '备份策略是每晚两点增量、周日全量，存 NAS。',
};
const POS = [
  ['这个项目的包管理器用什么？', 'pnpm'], ['装依赖该用哪个工具？', 'pnpm'], ['npm 还是 yarn 还是别的？', 'pnpm'],
  ['数据库连接池怎么配的？', 'pg'], ['pg 的连接数上限是多少？', 'pg'],
  ['图表配色有什么讲究？', 'palette'], ['界面颜色风格是什么？', 'palette'],
  ['上线流程是怎样的？', 'deploy'], ['发布前要做什么？', 'deploy'], ['灰度比例多少？', 'deploy'],
  ['中文字体用哪个？', 'font'], ['图里的字体怎么选？', 'font'],
  ['控制台在哪个端口？', 'port'], ['本地服务的地址是什么？', 'port'],
  ['周会什么时候开？', 'meeting'], ['例会安排在哪天？', 'meeting'],
  ['备份是怎么做的？', 'backup'], ['数据多久备份一次？', 'backup'],
];
const NEG_Q = [
  '这个电影结局什么意思？', '汇率最近怎么走？', '如何缓解腰痛？', '今晚吃什么好？', '明天天气怎么样？',
  '帮我写一首关于秋天的诗', 'docker 容器怎么限制内存？', 'git rebase 和 merge 区别？', 'css 怎么居中？',
  'nginx 反向代理怎么配？', 'sql 慢查询怎么优化？', 'k8s pod 一直重启怎么排查？', 'mac 怎么截图？',
  '小孩发烧了怎么办？', '推荐几本科幻小说', '高铁票怎么退？', '健身增肌吃什么？', '相机参数怎么设？',
];

async function embed(text) {
  const res = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status} — is Ollama on ${host} with '${model}' pulled?`);
  const { embedding } = await res.json();
  if (!Array.isArray(embedding) || !embedding.length) throw new Error('empty embedding');
  return embedding;
}
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const cache = new Map();
const emb = async (t) => { if (!cache.has(t)) cache.set(t, await embed(t)); return cache.get(t); };

const pos = [];
for (const [q, k] of POS) pos.push({ c: cos(await emb(q), await emb(DOCS[k])), q, k });
const neg = [];
for (const q of NEG_Q) for (const [k, d] of Object.entries(DOCS)) neg.push({ c: cos(await emb(q), await emb(d)), q, k });
pos.sort((a, b) => a.c - b.c); neg.sort((a, b) => b.c - a.c);

console.log(`model=${model} host=${host}`);
console.log(`正例最低3: ${pos.slice(0, 3).map((x) => `${x.c.toFixed(3)} ${x.q}↔${x.k}`).join(' | ')}`);
console.log(`负例最高3: ${neg.slice(0, 3).map((x) => `${x.c.toFixed(3)} ${x.q}↔${x.k}`).join(' | ')}`);
for (const floor of [0.55, 0.58, 0.6, 0.62]) {
  const leak = neg.filter((x) => x.c >= floor).length;
  const miss = pos.filter((x) => x.c < floor).length;
  console.log(`floor=${floor}: 负例漏过 ${leak}/${neg.length}  正例错杀 ${miss}/${pos.length}`);
}
console.log('\n判读：选「负例漏过=0」且「正例错杀」最小的 floor 进 SEMANTIC_RECALL_FLOORS；无法同时满足 → 该模型不进表（bypass 禁用，fail-closed）。');
