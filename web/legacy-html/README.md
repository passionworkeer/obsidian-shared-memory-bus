# Landing Page 预览

本项目 Landing Page 是**纯静态**的,无构建步骤、无外部依赖。

## 预览方式

### 方式 1: 直接打开(最简单)

双击 `web/index.html`,或在浏览器地址栏输入:

```
file:///E:/desktop/obsidian-shared-memory-bus/web/index.html
```

离线可用,所有 SVG 图标、样式、脚本都在本地。

### 方式 2: 本地静态服务器(推荐)

如果你需要真实 HTTP 环境(例如测试 clipboard API 在 file:// 下的兼容性):

```bash
# Python
python -m http.server 8080 --directory web

# 或 Node(http-server)
npx http-server web -p 8080
```

浏览器访问 `http://localhost:8080`。

## 文件清单

```
web/
├── index.html   # 页面结构 + 内嵌 SVG 架构图与特性图标
├── styles.css   # 深色工程主题,单一青绿强调色 #00d4aa
├── app.js       # 滚动渐入 / 复制按钮 / 移动端导航 / 年份
└── README.md    # 本文件
```

## 设计说明

- **配色**:深蓝灰底 `#0a0e14` + 单一强调色青绿 `#00d4aa`。工程感强,避免彩虹色,与"本地优先、数据可信"的项目气质匹配。
- **字体**:系统字体栈 + monospace 等宽(用于代码、端口、技术标签)。无外链 CDN 字体,完全离线。
- **图标**:全部 inline SVG,不依赖任何图标库,离线可用。
- **响应式**:980px / 760px / 460px 三个断点,覆盖桌面、平板、移动端。
- **可访问性**:语义化 HTML、skip-link、ARIA 标签、`prefers-reduced-motion` 支持、键盘可达。

## 内容来源

所有文案、特性、架构、端口、测试数据均来自项目根目录的 `README.md`。
