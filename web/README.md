# Landing Page（React + Vite）

`web/src` 是项目展示站点的唯一内容源。仓库不再提交 `dist/`、`docs/landing/` 或独立的 legacy HTML 副本，避免源码更新后静态副本继续展示旧端口和旧安装命令。

## 本地开发

```bash
cd web
npm ci
npm run dev
```

开发服务器默认使用 `http://localhost:5173`。

## 可复现构建

```bash
cd web
npm ci
npm run build
npm run preview
```

依赖由 `web/package-lock.json` 锁定。构建产物写入 `web/dist/`，它是唯一部署目标，可上传到 GitHub Pages、Vercel、Netlify、Cloudflare Pages 或其他静态托管。

`dist/` 是生成物并被 `.gitignore` 排除，不应提交到仓库。CI 会在干净环境中执行 `npm ci && npm run build`，检查输出中不存在已知的过时启动命令和端口文案，并上传构建产物供检查。

## 本地预览静态产物

```bash
python -m http.server 8080 --directory web/dist
```

也可以使用：

```bash
npx http-server web/dist -p 8080
```

## 结构

```text
web/
├── src/                React 源码与样式
├── screenshots-react/  桌面/移动截图
├── index.html          Vite HTML 入口
├── package.json
├── package-lock.json
└── vite.config.js
```

## 发布约束

1. 修改内容只能改 `web/src`、`web/index.html` 或相关构建配置。
2. 使用 `npm ci`，不要用未锁定的临时依赖生成正式产物。
3. 部署 `web/dist/`，不要重新创建手工维护的 HTML 副本。
4. 合并前必须通过 `Landing Build` 工作流。
5. 端口、安装方式或支持矩阵变化时，同步修改 React 源码中的展示内容。

## 交互特性

- 架构图层级 hover 与点击详情
- 记忆分层展示
- Agent 支持矩阵视图切换
- 快速开始复制与 Toast 反馈
- 滚动渐入和响应式布局
