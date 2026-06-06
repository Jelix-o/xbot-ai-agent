import type { ScheduleDateRule } from "../types.js";
import { isSmartNonWorkday, isSmartWorkday } from "./china-workday-calendar.js";

export function isScheduleDateRuleMatched(rule: ScheduleDateRule | undefined, weekdays: number[] | undefined, date: Date): boolean {
  const normalizedRule = rule ?? "all";
  if (normalizedRule === "workday") return isSmartWorkday(date);
  if (normalizedRule === "holiday") return isSmartNonWorkday(date);
  if (normalizedRule === "custom") return normalizeWeekdays(weekdays).includes(date.getDay());
  return true;
}

export function normalizeWeekdays(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)))
    .sort((left, right) => left - right);
}
