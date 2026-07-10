"""Take desktop + mobile screenshots of the React landing page."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088/"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("screenshots")
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        executable_path=r"D:\playwright-browsers\chromium-1223\chrome-win64\chrome.exe",
    )

    # Desktop full page
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(800)  # let reveal animations settle
    page.screenshot(path=str(OUT / "desktop-full.png"), full_page=True)
    ctx.close()
    print(f"[ok] {OUT / 'desktop-full.png'}")

    # Mobile full page (iPhone 13-ish)
    ctx2 = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15"
    )
    page2 = ctx2.new_page()
    page2.goto(URL, wait_until="networkidle", timeout=30000)
    page2.wait_for_timeout(800)
    page2.screenshot(path=str(OUT / "mobile-full.png"), full_page=True)
    ctx2.close()
    print(f"[ok] {OUT / 'mobile-full.png'}")

    browser.close()
print("done")
