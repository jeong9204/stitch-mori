"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** A native disclosure with ordinary Tab navigation; actions remain in the card flow. */
export function ActionMenu({ label, children }: { label: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    function outside(event: MouseEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute("open");
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && menu.current?.open && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        menu.current.open = false;
        trigger.current?.focus();
      }
    }
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <details ref={menu} className="action-menu" onToggle={event => {
    if (event.currentTarget.open) document.querySelectorAll<HTMLDetailsElement>(".action-menu[open]").forEach(other => {
      if (other !== event.currentTarget) other.open = false;
    });
  }}>
    <summary ref={trigger} aria-label={label} title={label}>···</summary>
    <div className="action-menu-content" aria-label={label} onClick={event => {
      if (event.target instanceof Element && event.target.closest("button,a")) {
        menu.current?.removeAttribute("open");
        if (trigger.current?.isConnected) trigger.current.focus();
      }
    }}>{children}</div>
  </details>;
}
