# Landing Page（React + Vite）

项目展示网站，基于 React + Vite。深蓝灰底 + 青绿强调色工程主题，7 大区 + 交互演示。

## 开发

```bash
cd web
npm install
npm run dev      # 开发服务器 http://localhost:5173
```

## 构建

```bash
npm run build    # 产物 → dist/
npm run preview  # 本地预览构建产物
```

`dist/` 是纯静态产物，可部署到任何静态托管（GitHub Pages / Vercel / Netlify / Cloudflare Pages）。

## 预览构建产物

```bash
python -m http.server 8080 --directory web/dist
# 或
npx http-server web/dist -p 8080
```

## 结构

```
web/
├── src/                # React 源码（main.jsx + App.jsx + 9 组件 + styles.css + hooks.js）
├── dist/               # 构建产物（静态可部署）
├── legacy-html/        # 旧纯 HTML 版（备份，纯静态无构建）
├── screenshots-react/  # React 版桌面/移动截图
├── index.html          # Vite 入口
├── vite.config.js
└── package.json
```

## 交互特性

- 架构图：层级 hover/点击展开详情 + 连线流动动画
- 记忆分层 L0-L5：阶梯 hover/点击显示持久化与生命周期
- 8 agent：三视图 Tab 切换（按支持等级 / 按接入方式 / 全部）
- 快速开始：复制按钮 + Toast 反馈
- 滚动渐入（IntersectionObserver）+ 响应式（桌面/移动）

## 设计

- **配色**：深蓝灰底 `#0a0e14` + 单一青绿强调色 `#00d4aa`。工程感，避免彩虹。
- **字体**：系统字体栈 + monospace（代码/端口/技术标签）。
- **内容来源**：根目录 `README.md`（A1 vault / A3 8 agent / 检索 / 差异化定位）。

## 旧 HTML 版

`legacy-html/` 保留了升级前的纯 HTML 版（无构建步骤，双击 index.html 即可）。如需最简预览可用它；正式展示用 React 版 `dist/`。
