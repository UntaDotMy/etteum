import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number): string {
  // Match AccountList formatCredit: exact millions show "2M" not "2.0M".
  if (num >= 1_000_000) {
    const m = num / 1_000_000;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (num >= 1_000) {
    const k = num / 1_000;
    return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return num.toString();
}

export function formatDateTimeID(value: string | Date): string {
  return parseUtcDate(value).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

export function formatTimeID(value: string | Date): string {
  return parseUtcDate(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function parseUtcDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}

export function formatPercentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}

export function modelColor(model: string, index = 0): string {
  let hash = 0;
  for (let i = 0; i < model.length; i++) {
    hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
  }

  // Golden-angle distribution keeps colors well separated even with many models.
  const hue = Math.round((hash + index * 137.508) % 360);
  return `hsl(${hue}, 88%, 58%)`;
}
