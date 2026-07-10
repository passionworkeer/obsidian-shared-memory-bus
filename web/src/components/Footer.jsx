export default function Footer({ year }) {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <span className="footer-name">yt</span>
          <span className="footer-tag">让 AI 工具共享记忆,告别重复解释。</span>
        </div>
        <div className="footer-links">
          <a
            href="https://github.com/passionworkeer/obsidian-shared-memory-bus"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://github.com/passionworkeer/obsidian-shared-memory-bus/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            MIT License
          </a>
          <a
            href="https://github.com/passionworkeer/obsidian-shared-memory-bus/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Issues
          </a>
        </div>
        <p className="footer-copy">© {year} yt · MIT</p>
      </div>
    </footer>
  );
}
