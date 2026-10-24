import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '../lib/cn.js';

const ARRIVE = { duration: 0.14, ease: [0.16, 1, 0.3, 1] };
const LEAVE = { duration: 0.09, ease: [0.32, 0.72, 0, 1] };

const GONE = { opacity: 0, scale: 0.6 };
const HERE = { opacity: 1, scale: 1 };

function figure(count) {
  if (typeof count !== 'number') return String(count);
  return count > 99 ? '99+' : String(count);
}

export function Badge({ count, quiet = false, className, ...rest }) {
  const still = useReducedMotion();
  const show = Boolean(count);
  const cls = cn('badge', quiet && 'badge--quiet', className);

  if (still) return show ? <span className={cls} {...rest}>{figure(count)}</span> : null;

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.span
          key="badge"
          className={cls}
          initial={GONE}
          animate={HERE}
          exit={{ ...GONE, transition: LEAVE }}
          transition={ARRIVE}
          {...rest}
        >
          {figure(count)}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
