import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...a: ClassValue[]): string => twMerge(clsx(a));

export default cn;
