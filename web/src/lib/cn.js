
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...parts) {
  return twMerge(clsx(parts));
}
