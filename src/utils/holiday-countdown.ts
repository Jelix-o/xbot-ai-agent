interface HolidayDefinition {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  daysOff: number;
}

const HOLIDAYS: HolidayDefinition[] = [
  { id: "2026-new-year", name: "元旦", startDate: "2026-01-01", endDate: "2026-01-03", daysOff: 3 },
  { id: "2026-spring-festival", name: "春节", startDate: "2026-02-15", endDate: "2026-02-23", daysOff: 9 },
  { id: "2026-qingming", name: "清明节", startDate: "2026-04-04", endDate: "2026-04-06", daysOff: 3 },
  { id: "2026-labour-day", name: "劳动节", startDate: "2026-05-01", endDate: "2026-05-05", daysOff: 5 },
  { id: "2026-dragon-boat", name: "端午节", startDate: "2026-06-19", endDate: "2026-06-21", daysOff: 3 },
  { id: "2026-mid-autumn", name: "中秋节", startDate: "2026-09-25", endDate: "2026-09-27", daysOff: 3 },
  { id: "2026-national-day", name: "国庆节", startDate: "2026-10-01", endDate: "2026-10-07", daysOff: 7 },
];

export function buildHolidayCountdownMessage(now = new Date()): string {
  const today = startOfDay(now);
  const holidayLines = getUpcomingHolidays(now, 5).map((holiday) =>
    `${formatDistanceLine(holiday.name, startOfDay(new Date(`${holiday.startDate}T00:00:00`)), today)}，放假 ${holiday.daysOff} 天`
  );

  return [
    `${formatDate(now)} ${formatTimePeriod(now)}好`,
    formatDistanceLine("周六", getNextSaturday(now), today),
    ...holidayLines,
  ].join("\n");
}

function getUpcomingHolidays(now: Date, limit: number): HolidayDefinition[] {
  const todayKey = toLocalDateKey(now);
  return HOLIDAYS
    .filter((holiday) => holiday.endDate >= todayKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .slice(0, limit);
}

function formatDistanceLine(label: string, targetDate: Date, today: Date): string {
  const diffDays = Math.max(0, Math.round((targetDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)));
  return `距离【${label}】还有 ${diffDays} 天`;
}

function getNextSaturday(now: Date): Date {
  const today = startOfDay(now);
  const day = today.getDay();
  const daysUntilSaturday = ((6 - day + 7) % 7) || 7;
  return new Date(today.getTime() + daysUntilSaturday * 24 * 60 * 60 * 1000);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

function formatTimePeriod(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "早上";
  if (hour < 14) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

function toLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0"),
  ].join("-");
}
