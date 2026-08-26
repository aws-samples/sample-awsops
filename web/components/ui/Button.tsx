import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand-action text-white hover:bg-brand-action-hover',
  secondary: 'bg-card border border-ink-100 text-ink-800 hover:bg-brand-action hover:text-white hover:border-brand-action',
  ghost: 'bg-transparent text-ink-600 hover:bg-ink-100 hover:text-ink-800',
  danger: 'bg-negative text-white hover:bg-negative/90',
};

// sizes 30 / 36 / 42px
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-3 text-[12px]',
  md: 'h-[36px] px-4 text-[14px]',
  lg: 'h-[42px] px-5 text-[14px]',
};

/**
 * Button — radius-md (8px), 500 weight, press = translateY(.5px),
 * brand focus ring. primary / secondary / ghost / danger × sm/md/lg.
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        'transition-colors duration-[120ms] cursor-pointer select-none',
        'active:translate-y-[.5px]',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'disabled:opacity-50 disabled:pointer-events-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
