// CI 用的构建脚本：从环境变量读 Notion token + database ID，生成 index.html
// 在 GitHub Actions 里运行：node build.js
const https = require('https');
const fs = require('fs');

const TOKEN = process.env.NOTION_TOKEN;
const DB    = process.env.NOTION_DB || '34fa083d-2ab2-81fd-bdcf-fa52eb77bf72';
const VERSION = '2022-06-28';

// 论文封面兜底：Notion「封面」字段为空时，按标题匹配用仓库内 covers/ 的 PDF 抽图
// （Notion 有封面时仍优先用 Notion 的；这里只做 fallback，不覆盖）
const COVER_OVERRIDES = [
  ['Fluxed Animated Boundary', 'covers/fab_moana.jpg'],
  ['Augmented MPM',            'covers/augmented_mpm.jpg'],
  ['MPM Snow',                 'covers/mpm_snow.jpg'],
  ['APIC',                     'covers/apic_jiang.jpg'],
  ['Thin Film',                'covers/thin_film.jpg'],
  ['Fluid Simulation for Computer Graphics', 'covers/bridson_fluids.jpg'],
  ['Animating Sand as a Fluid', 'covers/sand_zhu_bridson.jpg'],
  ['Surface Turbulence',       'covers/surface_turbulence.jpg'],
];

// 加载 SideFX cover 缓存（avoid rate-limit on every build）
let SIDEFX_CACHE = {};
try { SIDEFX_CACHE = JSON.parse(fs.readFileSync('sidefx_covers.json', 'utf8')); }
catch (e) { console.log('(no sidefx_covers.json cache)'); }

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
  m = url.match(/^https?:\/\/(?:www\.)?sidefx\.com\/tutorials\/[^?#]+/i); if (m) return { type: 'sidefx', id: url };
  m = url.match(/vimeo\.com\/(\d+)/); if (m) return { type: 'vimeo', id: m[1] };
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

// SideFX 教程页：优先用本地缓存（sidefx_covers.json），失败再抓 og:image / vimeo
async function getSideFXCover(pageUrl) {
  // 优先查缓存（避免 rate limit）
  if (SIDEFX_CACHE[pageUrl]) return SIDEFX_CACHE[pageUrl];

  const u = new URL(pageUrl);
  // 重试 3 次，rate limit 时退避
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await httpReq({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (r.status === 429 || r.status === 503) {
      const wait = 5000 * (attempt + 1);
      console.log(`    [SideFX ${r.status}] 等 ${wait}ms 重试 (attempt ${attempt+1})`);
      await new Promise(rr => setTimeout(rr, wait));
      continue;
    }
    if (r.status !== 200) {
      console.log(`    [SideFX ${r.status}] ${pageUrl}`);
      return null;
    }
    const html = r.body || '';
    // 1) og:image —— 排除站点默认 fallback
    let m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    if (m && m[1] && !/apple-touch-icon|favicon|default[-_]?cover/i.test(m[1])) return m[1];
    // 2) twitter:image
    m = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i);
    if (m && m[1] && !/apple-touch-icon|favicon|default[-_]?cover/i.test(m[1])) return m[1];
    // 3) 解析 vimeo iframe 拿 vimeo thumbnail
    m = html.match(/player\.vimeo\.com\/video\/(\d+)/);
    if (m && m[1]) return await getVimeoCover(m[1]);
    return null;
  }
  return null;
}

async function getVimeoCover(vimeoId) {
  // 公共 oembed API
  const r = await httpReq({
    hostname: 'vimeo.com',
    path: '/api/oembed.json?url=https%3A//vimeo.com/' + vimeoId,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  try {
    const j = JSON.parse(r.body);
    if (j.thumbnail_url) return j.thumbnail_url;
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
    let title = '', url = '', author = [], modules = [], scene = '';
    for (const k of Object.keys(p.properties)) {
      const v = p.properties[k];
      if (v.type === 'title') title = v.title.map(t => t.plain_text).join('');
      else if (v.id === 'ZsF%3B') url = (v.rich_text || []).map(t => t.href || t.plain_text).join('');
      else if (v.id === '%60XwP') author = (v.multi_select || []).map(o => o.name);
      else if (v.id === '%40HRA') modules = (v.multi_select || []).map(o => o.name);
      else if (v.id === 'gOb%3E') scene = (v.rich_text || []).map(t => t.plain_text).join('');
    }
    let cover = '';
    { const fp = p.properties['封面']; if (fp && fp.files && fp.files.length) { const f = fp.files[0]; cover = f.type === 'external' ? ((f.external && f.external.url) || '') : ((f.file && f.file.url) || ''); } }
    if (!cover) { for (const [key, cu] of COVER_OVERRIDES) { if (title.includes(key)) { cover = cu; break; } } }
    rows.push({ title, url, author, modules, scene, cover: cover || '', notion: p.url || '' });
    console.log(`[${i+1}/${data.results.length}] ${cover ? 'OK' : '--'} | ${title.substring(0,55)}`);
    // SideFX 教程页有 rate limit，sidefx 抓取后多等一会
    const delay = 0;
    await new Promise(r => setTimeout(r, delay));
  }

  // 作者按篇数归类：>5 篇保留独立标签，其余全部归入「其他」
  const authorCount = {};
  rows.forEach(r => r.author.forEach(a => { authorCount[a] = (authorCount[a] || 0) + 1; }));
  const commonAuthors = new Set(Object.keys(authorCount).filter(a => authorCount[a] > 5));
  const mapAuthor = a => commonAuthors.has(a) ? a : '其他';
  rows.forEach(r => { r.author = [...new Set(r.author.map(mapAuthor))]; });
  const hasOther = rows.some(r => r.author.includes('其他'));
  // 常见作者按篇数降序，「其他」始终排最后
  const allAuthors = [...commonAuthors].sort((a, b) => authorCount[b] - authorCount[a]);
  if (hasOther) allAuthors.push('其他');
  const allModules = [...new Set(rows.flatMap(r => r.modules))].sort();

  const ESC = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tagBtns = (arr, cls) => arr.map(t => `<button class="filter-btn ${cls}" data-${cls}="${ESC(t)}">${ESC(t)}</button>`).join('');

  const cards = rows.map(r => {
    const dataAttrs = `data-authors="${r.author.join('|')}" data-modules="${r.modules.join('|')}" data-text="${ESC((r.title + ' ' + r.scene).toLowerCase())}"`;
    const cover = r.cover
      ? `<img src="${ESC(r.cover)}" loading="lazy" referrerpolicy="no-referrer" alt="cover">`
      : '<div class="no-cover">无封面</div>';
    const tags = [
      ...r.author.map(a => `<span class="tag tag-author">${ESC(a)}</span>`),
      ...r.modules.map(m => `<span class="tag tag-module">${ESC(m)}</span>`),
    ].join('');
    const desc = r.scene
      ? (r.notion
          ? `<a class="card-desc card-desc-link" href="${ESC(r.notion)}" target="_blank" rel="noopener" title="点击查看 Notion 笔记">${ESC(r.scene)}</a>`
          : `<p class="card-desc">${ESC(r.scene)}</p>`)
      : '';
    return `<article class="card" ${dataAttrs}>
  <a class="card-cover" href="${ESC(r.url)}" target="_blank" rel="noopener">${cover}</a>
  <div class="card-body">
    <a class="card-title" href="${ESC(r.url)}" target="_blank" rel="noopener">${ESC(r.title)}</a>
    <div class="card-tags">${tags}</div>
    ${desc}
  </div>
</article>`;
  }).join('\n');

  const buildTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
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
  /* ===== 卡片画廊网格 ===== */
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 16px; padding: 24px; align-items: stretch; }
  @media (max-width: 1400px) { .grid { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 1000px) { .grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 700px)  { .grid { grid-template-columns: repeat(2, 1fr); } }
  .card { background: #fff; border: 1px solid #e9e8e4; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; transition: box-shadow 0.2s, transform 0.2s; }
  .card:hover { box-shadow: 0 8px 24px rgba(0,0,0,0.12); transform: translateY(-2px); }
  .card-cover { display: block; width: 100%; aspect-ratio: 16 / 9; background: #ececea; overflow: hidden; }
  .card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.3s; }
  .card:hover .card-cover img { transform: scale(1.04); }
  .card-cover .no-cover { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: #b0afab; font-size: 13px; }
  .card-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
  .card-title { color: #37352f; font-weight: 600; font-size: 15px; line-height: 1.4; text-decoration: none; }
  .card-title:hover { color: #2383e2; }
  .card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .card-desc { margin: 2px 0 0; color: #6b6a66; font-size: 12.5px; line-height: 1.6; display: block; }
  a.card-desc-link { text-decoration: none; cursor: pointer; transition: color 0.15s; }
  a.card-desc-link:hover { color: #2383e2; }
  .tag { display: inline-block; padding: 2px 6px; margin: 2px 3px 2px 0; border-radius: 3px; font-size: 11px; line-height: 1.4; white-space: nowrap; }
  .tag-author { background: #fbe5e3; color: #c1352b; font-weight: 500; }
  .tag-module { background: #ddedea; color: #0f7b6c; }
  .tag-effect { background: #fdecc8; color: #b07a1c; }
  .tag-tech   { background: #f1f0ed; color: #50504e; }
  .card.hidden { display: none; }
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
</header>
<main class="grid" id="grid">
${cards}
</main>
<footer>共 ${rows.length} 条 · 数据来自 Notion「特效技法索引」 · 自动每日同步 · 点击封面或标题跳转原视频</footer>
<script>
const filters = { author: new Set(), module: new Set(), text: '' };
const rows = Array.from(document.querySelectorAll('#grid .card'));
function applyFilters() {
  let visible = 0;
  rows.forEach(el => {
    const auths = (el.dataset.authors || '').split('|');
    const mods  = (el.dataset.modules || '').split('|');
    const text  = el.dataset.text || '';
    const okAuthor = filters.author.size === 0 || [...filters.author].some(a => auths.includes(a));
    const okModule = filters.module.size === 0 || [...filters.module].some(m => mods.includes(m));
    const okText   = !filters.text || text.includes(filters.text);
    const show = okAuthor && okModule && okText;
    el.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  document.getElementById('visible').textContent = visible;
}
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cls = btn.classList.contains('author') ? 'author' : 'module';
    const val = btn.dataset[cls];
    if (filters[cls].has(val)) { filters[cls].delete(val); btn.classList.remove('active', cls); }
    else { filters[cls].add(val); btn.classList.add('active', cls); }
    applyFilters();
  });
});
document.getElementById('search').addEventListener('input', e => { filters.text = e.target.value.trim().toLowerCase(); applyFilters(); });
document.getElementById('reset').addEventListener('click', () => {
  filters.author.clear(); filters.module.clear(); filters.text = '';
  document.querySelectorAll('.filter-btn.active').forEach(b => b.classList.remove('active', 'author', 'module'));
  document.getElementById('search').value = '';
  applyFilters();
});
</script>
</body>
</html>`;

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ 已生成 index.html (${html.length} bytes)`);
})();
