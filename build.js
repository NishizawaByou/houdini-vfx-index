// CI 用的构建脚本：从环境变量读 Notion token + database ID，生成 index.html
// 在 GitHub Actions 里运行：node build.js
const https = require('https');
const fs = require('fs');

const TOKEN = process.env.NOTION_TOKEN;
const DB    = process.env.NOTION_DB || '34fa083d-2ab2-81fd-bdcf-fa52eb77bf72';
const VERSION = '2022-06-28';

if (!TOKEN) {
  console.error('❌ 缺少 NOTION_TOKEN 环境变量');
  process.exit(1);
}

function httpReq(opt, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseSource(url) {
  if (!url) return null;
  let m;
  m = url.match(/youtube\.com\/watch\?v=([\w\-]+)/); if (m) return { type: 'yt', id: m[1] };
  m = url.match(/youtu\.be\/([\w\-]+)/);             if (m) return { type: 'yt', id: m[1] };
  m = url.match(/bilibili\.com\/video\/(BV[\w]+)/i); if (m) return { type: 'bili', id: m[1] };
  return null;
}

async function checkUrl(url) {
  return new Promise(resolve => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function getYTCover(id) {
  const cands = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];
  for (const u of cands) {
    if (await checkUrl(u) === 200) return u;
  }
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

async function getBiliCover(bvid) {
  const r = await httpReq({
    hostname: 'api.bilibili.com',
    path: `/x/web-interface/view?bvid=${bvid}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://www.bilibili.com/'
    }
  });
  try {
    const j = JSON.parse(r.body);
    if (j.code === 0 && j.data.pic) return j.data.pic.replace(/^http:/, 'https:');
  } catch (e) {}
  return null;
}

(async () => {
  console.log('Notion → 拉取数据库（翻页）...');
  let allResults = [];
  let cursor = null;
  let pageNum = 0;
  do {
    const body = { page_size: 100, sorts: [{ property: '作者', direction: 'ascending' }] };
    if (cursor) body.start_cursor = cursor;
    const q = await httpReq({
      hostname: 'api.notion.com',
      path: `/v1/databases/${DB}/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': VERSION,
        'Content-Type': 'application/json'
      }
    }, JSON.stringify(body));

    if (q.status !== 200) {
      console.error('Notion API 失败:', q.body.substring(0, 400));
      process.exit(1);
    }
    const data = JSON.parse(q.body);
    allResults = allResults.concat(data.results);
    pageNum++;
    console.log(`  第 ${pageNum} 页: +${data.results.length} 条 (累计 ${allResults.length})`);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  console.log(`共 ${allResults.length} 条（跨 ${pageNum} 页）`);
  const data = { results: allResults };

  const rows = [];
  for (let i = 0; i < data.results.length; i++) {
    const p = data.results[i];
    let title = '', url = '', author = [], modules = [], effects = [], tags = [], scene = '';
    for (const k of Object.keys(p.properties)) {
      const v = p.properties[k];
      if (v.type === 'title') title = v.title.map(t => t.plain_text).join('');
      else if (v.type === 'url') url = v.url || '';
      else if (v.id === '%60XwP') author = (v.multi_select || []).map(o => o.name);
      else if (v.id === '%40HRA') modules = (v.multi_select || []).map(o => o.name);
      else if (v.id === 'N%5B%7Cc') effects = (v.multi_select || []).map(o => o.name);
      else if (v.id === 'V%7DkO') tags = (v.multi_select || []).map(o => o.name);
      else if (v.id === 'gOb%3E') scene = (v.rich_text || []).map(t => t.plain_text).join('');
    }
    const src = parseSource(url);
    let cover = '';
    if (src) {
      cover = src.type === 'yt' ? await getYTCover(src.id) : await getBiliCover(src.id);
    }
    rows.push({ title, url, author, modules, effects, tags, scene, cover: cover || '' });
    console.log(`[${i+1}/${data.results.length}] ${cover ? 'OK' : '--'} | ${title.substring(0,55)}`);
    await new Promise(r => setTimeout(r, 150));
  }

  const allAuthors = [...new Set(rows.flatMap(r => r.author))].sort();
  const allModules = [...new Set(rows.flatMap(r => r.modules))].sort();
  const allEffects = [...new Set(rows.flatMap(r => r.effects))].sort();

  const ESC = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tagBtns = (arr, cls) => arr.map(t => `<button class="filter-btn ${cls}" data-${cls}="${ESC(t)}">${ESC(t)}</button>`).join('');

  const tableRows = rows.map(r => {
    const dataAttrs = `data-authors="${r.author.join('|')}" data-modules="${r.modules.join('|')}" data-effects="${r.effects.join('|')}" data-text="${ESC((r.title + ' ' + r.scene + ' ' + r.tags.join(' ')).toLowerCase())}"`;
    const cover = r.cover
      ? `<a href="${ESC(r.url)}" target="_blank" rel="noopener"><img src="${ESC(r.cover)}" loading="lazy" alt="cover"></a>`
      : '<div class="no-cover">无封面</div>';
    return `<tr ${dataAttrs}>
  <td class="cover-cell">${cover}</td>
  <td class="title-cell"><a href="${ESC(r.url)}" target="_blank" rel="noopener">${ESC(r.title)}</a><div class="scene">${ESC(r.scene)}</div></td>
  <td>${r.author.map(a => `<span class="tag tag-author">${ESC(a)}</span>`).join('')}</td>
  <td>${r.modules.map(m => `<span class="tag tag-module">${ESC(m)}</span>`).join('')}</td>
  <td>${r.effects.map(e => `<span class="tag tag-effect">${ESC(e)}</span>`).join('')}</td>
  <td>${r.tags.map(t => `<span class="tag tag-tech">${ESC(t)}</span>`).join('')}</td>
</tr>`;
  }).join('\n');

  const buildTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>特效技法索引 · 封面表格</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #f7f6f3; color: #37352f; font-size: 14px; }
  header { position: sticky; top: 0; z-index: 100; background: #fff; border-bottom: 1px solid #e3e2de; padding: 16px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  h1 { margin: 0 0 12px; font-size: 22px; }
  .stats { color: #787774; font-size: 13px; margin-bottom: 12px; }
  .stats span { color: #37352f; font-weight: 500; }
  .filter-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .filter-row label { font-size: 12px; color: #787774; padding: 6px 8px 0 0; min-width: 56px; text-align: right; }
  .filter-group { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; max-width: calc(100% - 64px); }
  .filter-btn { border: 1px solid #e3e2de; background: #fff; padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; color: #37352f; transition: all 0.15s; }
  .filter-btn:hover { background: #f1f0ed; }
  .filter-btn.active { background: #2383e2; color: #fff; border-color: #2383e2; }
  .filter-btn.active.author { background: #d44c47; border-color: #d44c47; }
  .filter-btn.active.module { background: #0f7b6c; border-color: #0f7b6c; }
  .filter-btn.active.effect { background: #cb912f; border-color: #cb912f; }
  #search { width: 280px; padding: 6px 10px; border: 1px solid #e3e2de; border-radius: 4px; font-size: 13px; outline: none; }
  #search:focus { border-color: #2383e2; }
  #reset { margin-left: 8px; padding: 6px 14px; border: 1px solid #e3e2de; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; }
  #reset:hover { background: #f1f0ed; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  thead { position: sticky; top: 196px; z-index: 50; background: #f7f6f3; }
  th { text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 500; color: #787774; border-bottom: 1px solid #e3e2de; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid #ececea; }
  tr:hover td { background: #fafaf9; }
  .cover-cell { width: 320px; padding: 8px; }
  .cover-cell img { width: 100%; height: 180px; object-fit: cover; border-radius: 6px; display: block; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: transform 0.2s, box-shadow 0.2s; }
  .cover-cell img:hover { transform: scale(1.02); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .no-cover { width: 100%; height: 180px; background: #ececea; display: flex; align-items: center; justify-content: center; border-radius: 6px; color: #999; }
  .title-cell { width: 280px; }
  .title-cell a { color: #37352f; font-weight: 500; text-decoration: none; line-height: 1.4; display: block; }
  .title-cell a:hover { color: #2383e2; text-decoration: underline; }
  .scene { color: #787774; font-size: 12px; margin-top: 6px; line-height: 1.5; }
  .tag { display: inline-block; padding: 2px 6px; margin: 2px 3px 2px 0; border-radius: 3px; font-size: 11px; line-height: 1.4; white-space: nowrap; }
  .tag-author { background: #fbe5e3; color: #c1352b; font-weight: 500; }
  .tag-module { background: #ddedea; color: #0f7b6c; }
  .tag-effect { background: #fdecc8; color: #b07a1c; }
  .tag-tech   { background: #f1f0ed; color: #50504e; }
  tr.hidden { display: none; }
  footer { text-align: center; padding: 24px; color: #787774; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>🎯 特效技法索引</h1>
  <div class="stats">共 <span id="total">${rows.length}</span> 条教程，当前显示 <span id="visible">${rows.length}</span> 条 · 上次同步：${buildTime}</div>
  <div class="filter-row">
    <label>搜索</label>
    <div class="filter-group"><input id="search" type="text" placeholder="搜索标题 / 标签 / 描述..."><button id="reset">重置筛选</button></div>
  </div>
  <div class="filter-row"><label>作者</label><div class="filter-group">${tagBtns(allAuthors, 'author')}</div></div>
  <div class="filter-row"><label>模块</label><div class="filter-group">${tagBtns(allModules, 'module')}</div></div>
  <div class="filter-row"><label>效果</label><div class="filter-group">${tagBtns(allEffects, 'effect')}</div></div>
</header>
<table>
  <thead><tr><th>封面</th><th>标题 / 简介</th><th>作者</th><th>Houdini模块</th><th>效果类型</th><th>技术标签</th></tr></thead>
  <tbody id="tbody">
${tableRows}
  </tbody>
</table>
<footer>共 ${rows.length} 条 · 数据来自 Notion「特效技法索引」 · 自动每日同步 · 点击封面或标题跳转原视频</footer>
<script>
const filters = { author: new Set(), module: new Set(), effect: new Set(), text: '' };
const rows = Array.from(document.querySelectorAll('#tbody tr'));
function applyFilters() {
  let visible = 0;
  rows.forEach(tr => {
    const auths = (tr.dataset.authors || '').split('|');
    const mods  = (tr.dataset.modules || '').split('|');
    const effs  = (tr.dataset.effects || '').split('|');
    const text  = tr.dataset.text || '';
    const okAuthor = filters.author.size === 0 || [...filters.author].every(a => auths.includes(a));
    const okModule = filters.module.size === 0 || [...filters.module].every(m => mods.includes(m));
    const okEffect = filters.effect.size === 0 || [...filters.effect].every(e => effs.includes(e));
    const okText   = !filters.text || text.includes(filters.text);
    const show = okAuthor && okModule && okEffect && okText;
    tr.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  document.getElementById('visible').textContent = visible;
}
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cls = btn.classList.contains('author') ? 'author' : btn.classList.contains('module') ? 'module' : 'effect';
    const val = btn.dataset[cls];
    if (filters[cls].has(val)) { filters[cls].delete(val); btn.classList.remove('active', cls); }
    else { filters[cls].add(val); btn.classList.add('active', cls); }
    applyFilters();
  });
});
document.getElementById('search').addEventListener('input', e => { filters.text = e.target.value.trim().toLowerCase(); applyFilters(); });
document.getElementById('reset').addEventListener('click', () => {
  filters.author.clear(); filters.module.clear(); filters.effect.clear(); filters.text = '';
  document.querySelectorAll('.filter-btn.active').forEach(b => b.classList.remove('active', 'author', 'module', 'effect'));
  document.getElementById('search').value = '';
  applyFilters();
});
</script>
</body>
</html>`;

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ 已生成 index.html (${html.length} bytes)`);
})();
