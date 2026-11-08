// the slim bar for pages outside the app layout (the reply link page and the demo outbox): the name, nothing else
import Link from "next/link";
import type { ReactNode } from "react";
import s from "./MinimalHeader.module.css";

export function MinimalHeader({ href, trailing }: { href?: string; trailing?: ReactNode }) {
  return (
    <header className={s.bar}>
      <div className={s.inner}>
        {href ? (
          <Link href={href} className={s.brand}>
            ReliefReady
          </Link>
        ) : (
          <span className={s.brand}>ReliefReady</span>
        )}
        {trailing && <span className={s.trailing}>{trailing}</span>}
      </div>
    </header>
  );
}
