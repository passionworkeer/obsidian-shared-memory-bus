import { useEffect, useState } from "react";
import Header from "./components/Header.jsx";
import Hero from "./components/Hero.jsx";
import Features from "./components/Features.jsx";
import Architecture from "./components/Architecture.jsx";
import Tools from "./components/Tools.jsx";
import Tiers from "./components/Tiers.jsx";
import Quickstart from "./components/Quickstart.jsx";
import Trust from "./components/Trust.jsx";
import Footer from "./components/Footer.jsx";
import Toast from "./components/Toast.jsx";

export default function App() {
  const [toast, setToast] = useState({ show: false, msg: "" });
  const [year, setYear] = useState(2026);

  useEffect(() => {
    setYear(new Date().getFullYear());
  }, []);

  const showToast = (msg) => {
    setToast({ show: true, msg });
  };

  return (
    <>
      <a href="#main" className="skip-link">跳到主内容</a>
      <Header />
      <main id="main">
        <span id="top"></span>
        <Hero />
        <Features />
        <Architecture />
        <Tools />
        <Tiers />
        <Quickstart onToast={showToast} />
        <Trust />
      </main>
      <Footer year={year} />
      <Toast toast={toast} setToast={setToast} />
    </>
  );
}
