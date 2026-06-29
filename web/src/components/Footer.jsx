export default function Footer({ year }) {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <span className="footer-name">Local AI Memory Bus</span>
          <span className="footer-tag">让 AI 工具共享记忆,告别重复解释。</span>
        </div>
        <div className="footer-links">
          <a
            href="https://github.com/passionworkeer/local-ai-memory-bus"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://github.com/passionworkeer/local-ai-memory-bus/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            MIT License
          </a>
          <a
            href="https://github.com/passionworkeer/local-ai-memory-bus/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Issues
          </a>
        </div>
        <p className="footer-copy">© {year} Local AI Memory Bus · MIT</p>
      </div>
    </footer>
  );
}
