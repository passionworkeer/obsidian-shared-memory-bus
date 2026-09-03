/**
 * skills/user-portrait/lib/dashboard-template.js
 * ---------------------------------------------
 * Single-file offline dashboard template. No CDN, no external fonts — works
 * from file:// on any OS. `__PORTRAIT_DATA__` is replaced with the stats JSON
 * (with `<` escaped to \\u003c to prevent </script> breakout).
 *
 * NOTE: this file is a plain template — the embedded JS below deliberately
 * avoids template literals so the outer template literal stays intact.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>用户画像 · User Portrait</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c2330; --line: #2a3242;
    --fg: #e6edf3; --dim: #8b98a9; --accent: #4cc2ff; --accent2: #7ee787;
    --warn: #ffa657; --hot: #ff7b72;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font: 14px/1.65 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; padding: 28px 20px 60px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 650; }
  h1 .en { color: var(--dim); font-weight: 400; font-size: 14px; margin-left: 10px; }
  .meta { color: var(--dim); font-size: 12.5px; margin: 6px 0 22px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .kpi .v { font-size: 26px; font-weight: 700; color: var(--accent); }
  .kpi .l { color: var(--dim); font-size: 12px; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
  .card h2 { font-size: 14px; font-weight: 650; color: var(--fg); margin-bottom: 12px; }
  .card h2 span { color: var(--dim); font-weight: 400; font-size: 12px; margin-left: 8px; }
  .bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
  .bars .b { flex: 1; min-width: 3px; background: linear-gradient(180deg, var(--accent), #2a6f9e); border-radius: 2px 2px 0 0; position: relative; }
  .bars .b:hover::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--panel2); border: 1px solid var(--line); padding: 3px 8px; border-radius: 6px; font-size: 11px; white-space: nowrap; z-index: 5; }
  .axis { color: var(--dim); font-size: 10.5px; display: flex; justify-content: space-between; margin-top: 6px; }
  .hbar { display: flex; align-items: center; gap: 10px; margin: 5px 0; }
  .hbar .name { width: 150px; color: var(--fg); font-size: 12.5px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar .track { flex: 1; background: var(--panel2); border-radius: 5px; height: 14px; overflow: hidden; }
  .hbar .fill { height: 100%; background: linear-gradient(90deg, #2a6f9e, var(--accent)); border-radius: 5px; }
  .hbar .num { width: 60px; color: var(--dim); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .chip { background: var(--panel2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 12px; color: var(--fg); white-space: nowrap; }
  .chip.cjk { border-color: #2f4a3a; color: var(--accent2); }
  .chip small { color: var(--dim); font-size: 10px; margin-left: 4px; }
  .foot { color: var(--dim); font-size: 12px; margin-top: 26px; border-top: 1px solid var(--line); padding-top: 14px; }
  .tag { display: inline-block; font-size: 11px; border-radius: 6px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
  .tag.hot { background: #3a2226; color: var(--hot); }
  .tag.ok { background: #1d3326; color: var(--accent2); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 4px 6px; border-bottom: 1px solid var(--line); }
  td.n { text-align: right; color: var(--accent); width: 90px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>用户画像<span class="en">User Portrait · yt user-portrait skill</span></h1>
  <div class="meta" id="meta"></div>
  <div class="kpis" id="kpis"></div>

  <div class="card">
    <h2>近 90 天活动<span>每天的用户消息数</span></h2>
    <div class="bars" id="timeline"></div>
    <div class="axis" id="timelineAxis"></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>24 小时分布<span>什么时候在说话</span></h2>
      <div class="bars" id="hours"></div>
      <div class="axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
      <div class="meta" id="rhythm"></div>
    </div>
    <div class="card">
      <h2>星期分布</h2>
      <div class="bars" id="weekdays"></div>
      <div class="axis"><span>周日</span><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>周六</span></div>
    </div>
  </div>

  <div class="card">
    <h2>数据来源构成</h2>
    <div id="sources"></div>
  </div>

  <div class="card">
    <h2>高频关键词<span>蓝色=技术/英文 · 绿色=中文词 · 数字=出现次数</span></h2>
    <div class="chips" id="keywords"></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>项目足迹</h2>
      <div id="projects"></div>
    </div>
    <div class="card">
      <h2>表达习惯</h2>
      <div id="style"></div>
    </div>
  </div>

  <div class="card" id="chatCard" style="display:none">
    <h2>聊天记录导入(微信 / QQ)</h2>
    <div id="chat"></div>
  </div>

  <div class="foot">
    ⚠ 本页含 <b>P2 高隐私</b> 个人数据,仅限本地查看,请勿截图/上传。<br>
    生成引擎: obsidian-shared-memory-bus · skills/user-portrait · 数据经自动脱敏。
  </div>
</div>

<script>
var DATA = __PORTRAIT_DATA__;
function el(id) { return document.getElementById(id); }
function fmtDate(ms) { if (!ms) return "—"; var d = new Date(ms); function p(x){return (x<10?"0":"")+x;} return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()); }
function bars(node, items, tips) {
  var max = 1; for (var i = 0; i < items.length; i++) max = Math.max(max, items[i]);
  var html = "";
  for (var j = 0; j < items.length; j++) {
    var h = Math.max(items[j] > 0 ? 4 : 0, Math.round(items[j] / max * 100));
    html += '<div class="b" style="height:' + h + '%" data-tip="' + (tips ? tips[j] : items[j]) + '"></div>';
  }
  node.innerHTML = html;
}

el("meta").textContent = "数据范围 " + fmtDate(DATA.first_ts) + " → " + fmtDate(DATA.last_ts) + " ｜ 生成于 " + (DATA.generated_at || "").slice(0, 16);

var kpis = [
  [DATA.total.toLocaleString(), "用户消息(去重)"],
  [DATA.activity.active_days, "活跃天数"],
  [Object.keys(DATA.sources).length, "数据来源"],
  [DATA.activity.longest_streak + " 天", "最长连续活跃"]
];
el("kpis").innerHTML = kpis.map(function (k) { return '<div class="kpi"><div class="v">' + k[0] + '</div><div class="l">' + k[1] + '</div></div>'; }).join("");

(function timeline() {
  var days = DATA.days || {};
  var keys = Object.keys(days).sort().slice(-90);
  var vals = keys.map(function (k) { return days[k]; });
  var tips = keys.map(function (k) { return k + " · " + days[k] + " 条"; });
  bars(el("timeline"), vals, tips);
  var ax = el("timelineAxis");
  if (keys.length > 1) {
    ax.innerHTML = "<span>" + keys[0] + "</span><span>" + keys[Math.floor(keys.length / 2)] + "</span><span>" + keys[keys.length - 1] + "</span>";
  }
})();

(function hours() {
  bars(el("hours"), DATA.hours, DATA.hours.map(function (c, h) { return h + ":00 · " + c + " 条"; }));
  var peak = DATA.hours.map(function (c, h) { return { h: h, c: c }; }).sort(function (a, b) { return b.c - a.c; })[0];
  var night = DATA.activity.night_ratio || 0;
  var kind = night > 0.25 ? "夜猫型 🌙" : (night < 0.05 ? "早睡型 ☀️" : "常规型");
  el("rhythm").innerHTML = "高峰 " + peak.h + ":00 ｜ 深夜占比 " + Math.round(night * 100) + "% → <b>" + kind + "</b>" +
    ' ｜ 周末占比 ' + Math.round((DATA.activity.weekend_ratio || 0) * 100) + "%";
})();

(function weekdays() {
  var names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  bars(el("weekdays"), DATA.weekdays, DATA.weekdays.map(function (c, d) { return names[d] + " · " + c; }));
})();

(function sources() {
  var entries = Object.keys(DATA.sources).map(function (k) { return [k, DATA.sources[k].count]; }).sort(function (a, b) { return b[1] - a[1]; });
  var max = entries.length ? entries[0][1] : 1;
  el("sources").innerHTML = entries.map(function (e) {
    return '<div class="hbar"><div class="name">' + e[0] + '</div><div class="track"><div class="fill" style="width:' + Math.max(2, Math.round(e[1] / max * 100)) + '%"></div></div><div class="num">' + e[1] + '</div></div>';
  }).join("");
})();

(function keywords() {
  var latin = (DATA.top_latin_terms || []).slice(0, 24);
  var cjk = (DATA.top_cjk_terms || []).slice(0, 24);
  var all = latin.concat(cjk).map(function (x) { return { t: x.t, n: x.n, cjk: /[\\u4e00-\\u9fff]/.test(x.t) }; });
  all.sort(function (a, b) { return b.n - a.n; });
  var min = all.length ? all[all.length - 1].n : 1, max = all.length ? all[0].n : 1;
  el("keywords").innerHTML = all.map(function (x) {
    var size = 11 + Math.round((x.n - min) / Math.max(1, max - min) * 9);
    return '<span class="chip' + (x.cjk ? " cjk" : "") + '" style="font-size:' + size + 'px">' + x.t + "<small>" + x.n + "</small></span>";
  }).join("");
})();

(function projects() {
  var ps = DATA.top_projects || [];
  if (!ps.length) { el("projects").innerHTML = '<div class="meta">无项目目录信息</div>'; return; }
  var max = ps[0].n;
  el("projects").innerHTML = ps.slice(0, 12).map(function (p) {
    return '<div class="hbar"><div class="name">' + p.t + '</div><div class="track"><div class="fill" style="width:' + Math.max(2, Math.round(p.n / max * 100)) + '%"></div></div><div class="num">' + p.n + "</div></div>";
  }).join("");
})();

(function style() {
  var lang = DATA.language || {}, act = DATA.activity || {};
  var rows = [
    ["中文消息占比", Math.round((lang.cjk_msgs_ratio || 0) * 100) + "%"],
    ["平均消息长度", (act.avg_len || 0) + " 字符"],
    ["疑问句占比", Math.round((act.question_ratio || 0) * 100) + "%"],
    ["周末活跃占比", Math.round((act.weekend_ratio || 0) * 100) + "%"]
  ];
  el("style").innerHTML = "<table>" + rows.map(function (r) { return "<tr><td>" + r[0] + "</td><td class='n'>" + r[1] + "</td></tr>"; }).join("") + "</table>";
})();

(function chat() {
  var c = DATA.chat || {};
  if (!c.total) return;
  el("chatCard").style.display = "";
  var peers = (DATA.top_peers || []).slice(0, 10);
  el("chat").innerHTML =
    "共导入 <b>" + c.total + "</b> 条,本人发送 <b>" + c.from_user + "</b> 条,涉及 <b>" + peers.length + "</b> 个对话。" +
    peers.map(function (p) { return '<span class="chip cjk">' + p.t + "<small>" + p.n + "</small></span>"; }).join("");
})();
</script>
</body>
</html>
`;
