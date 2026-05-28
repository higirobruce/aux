import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn `cn` helper — Tailwind-class-aware className composer. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
