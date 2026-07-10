import { useEffect, useRef } from "react";

export default function Toast({ toast, setToast }) {
  const timer = useRef(null);

  useEffect(() => {
    if (toast.show) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setToast((t) => ({ ...t, show: false }));
      }, 1800);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, setToast]);

  return (
    <div
      className={`toast${toast.show ? " show" : ""}`}
      role="status"
      aria-live="polite"
    >
      {toast.msg}
    </div>
  );
}
