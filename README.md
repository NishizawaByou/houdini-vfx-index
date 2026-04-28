# Houdini VFX Tutorial Index

自动从 Notion 同步的 Houdini 特效教程索引画廊。

🌐 **在线访问**：https://nishizawabyou.github.io/houdini-vfx-index/

## 功能

- 表格视图，每条教程展示大封面图
- 按作者 / Houdini 模块 / 效果类型 多维筛选
- 搜索标题、技术标签、场景描述
- 点击封面或标题直达原视频（YouTube / Bilibili）

## 自动同步

- **每日北京时间凌晨 4:00** GitHub Actions 自动从 Notion 拉数据
- 重新生成 `index.html`，提交到 main 分支
- GitHub Pages 自动重新部署
- 手动触发：仓库 Actions → Sync from Notion → Run workflow

## 数据来源

Notion 数据库「特效技法索引」`34fa083d-2ab2-81fd-bdcf-fa52eb77bf72`

## 字段映射

| Notion 字段 | 用途 |
|---|---|
| 标题 (title) | 教程标题 |
| 视频源 (url) | YouTube / Bilibili 视频链接 |
| 作者 (multi_select) | 教程原作者品牌 |
| Houdini模块 (multi_select) | SOP / VEX / Pyro 等 |
| 效果类型 (multi_select) | 流体 / 烟雾 / 程序化建模 等 |
| 技术标签 (multi_select) | 详细技术关键词 |
| 场景一句话 (rich_text) | 一句话描述 |
| 封面 (files) | 视频封面 URL |
