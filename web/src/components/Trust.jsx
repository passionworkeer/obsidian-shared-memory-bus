import { useReveal } from "../hooks.js";

const STATS = [
  {
    stat: "100",
    unit: "%",
    label: "测试全绿 · 1300 用例(JS 718 + Python 582)0 fail 0 skip"
  },
  {
    stat: "3",
    unit: "平台",
    label: "Windows / macOS / Linux 全平台支持"
  },
  {
    stat: "MIT",
    unit: "",
    label: "开源协议,自由使用、修改、分发"
  },
  {
    stat: "Node ≥ 18",
    unit: "",
    label: "单一运行时依赖,Python 仅用于可选语义检索"
  }
];

export default function Trust() {
  const { ref, inView } = useReveal();

  return (
    <section className="section section-alt trust" aria-labelledby="trust-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">可信度</p>
          <h2 id="trust-title" className="section-title">工程级可靠性</h2>
        </header>
        <div className="trust-grid reveal in-view">
          {STATS.map((s, i) => (
            <TrustCard key={i} stat={s} />
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustCard({ stat }) {
  const { ref, inView } = useReveal();
  return (
    <div className={`trust-card reveal${inView ? " in-view" : ""}`} ref={ref}>
      <div className="trust-stat">
        {stat.stat}
        {stat.unit && <span className="trust-unit">{stat.unit}</span>}
      </div>
      <div className="trust-label">{stat.label}</div>
    </div>
  );
}
