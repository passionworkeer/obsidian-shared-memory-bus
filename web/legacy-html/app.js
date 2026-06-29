/* ============================================================
   Local AI Memory Bus — Landing Page
   原生 JS,无依赖
   ============================================================ */
(function () {
  "use strict";

  // ---- Year ----
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ---- Mobile nav toggle ----
  var navToggle = document.querySelector(".nav-toggle");
  var siteNav = document.querySelector(".site-nav");
  if (navToggle && siteNav) {
    navToggle.addEventListener("click", function () {
      var open = siteNav.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // 点击导航项后关闭(移动端)
    siteNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        if (siteNav.classList.contains("open")) {
          siteNav.classList.remove("open");
          navToggle.setAttribute("aria-expanded", "false");
        }
      });
    });
  }

  // ---- Scroll reveal ----
  var revealEls = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && revealEls.length) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -60px 0px", threshold: 0.12 }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    // fallback: 直接显示
    revealEls.forEach(function (el) { el.classList.add("in-view"); });
  }

  // ---- Copy buttons ----
  var toast = document.getElementById("toast");
  var toastTimer = null;
  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("show");
    }, 1800);
  }

  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      if (!text) return;
      var labelEl = btn.querySelector("span");
      var originalLabel = labelEl ? labelEl.textContent : "";

      function onSuccess() {
        btn.classList.add("copied");
        if (labelEl) labelEl.textContent = "已复制";
        showToast("命令已复制到剪贴板");
        setTimeout(function () {
          btn.classList.remove("copied");
          if (labelEl) labelEl.textContent = originalLabel;
        }, 1600);
      }

      function onError() {
        // fallback: 选中文本供用户手动复制
        showToast("复制失败,请手动选择命令");
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess).catch(function () {
          legacyCopy(text, onSuccess, onError);
        });
      } else {
        legacyCopy(text, onSuccess, onError);
      }
    });
  });

  function legacyCopy(text, onOk, onErr) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) onOk();
      else onErr();
    } catch (e) {
      onErr();
    }
  }
})();
