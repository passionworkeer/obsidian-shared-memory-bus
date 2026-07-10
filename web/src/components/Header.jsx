import { useState, useEffect } from "react";

const NAV_LINKS = [
  { href: "#features", label: "特性" },
  { href: "#architecture", label: "架构" },
  { href: "#tools", label: "支持工具" },
  { href: "#tiers", label: "记忆分层" },
  { href: "#quickstart", label: "快速开始" }
];

export default function Header() {
  const [open, setOpen] = useState(false);

  // Close mobile nav on hash navigation.
  useEffect(() => {
    const handler = () => setOpen(false);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return (
    <header className="site-header reveal in-view">
      <div className="container header-inner">
        <a className="brand" href="#top" aria-label="返回顶部">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="3" y="3" width="26" height="26" rx="6" fill="none" stroke="currentColor" strokeWidth="1.6"/>
            <circle cx="16" cy="16" r="3.2" fill="var(--accent)"/>
            <path d="M16 6v4M16 22v4M6 16h4M22 16h4M9 9l2.8 2.8M20.2 20.2L23 23M9 23l2.8-2.8M20.2 11.8L23 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <span className="brand-text">yt</span>
        </a>
        <nav className={`site-nav${open ? " open" : ""}`} aria-label="主导航">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href}>{l.label}</a>
          ))}
          <a
            className="nav-cta"
            href="https://github.com/passionworkeer/obsidian-shared-memory-bus"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </nav>
        <button
          className="nav-toggle"
          aria-label="切换导航"
          aria-expanded={open ? "true" : "false"}
          onClick={() => setOpen((v) => !v)}
        >
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
  );
}
