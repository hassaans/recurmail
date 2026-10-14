export const packageName = "@recurmail/core";

export type {
  AccountType,
  DailyLimitResult,
  DailyLimitStatus,
  LimitSchedule,
} from "./daily-limit.ts";
export { dailyLimitCheck } from "./daily-limit.ts";
export type { Mailbox, MimeMessage, NamedMailbox } from "./mime.ts";
export { buildMime } from "./mime.ts";
export type { PresetTime, Weekday } from "./schedule.ts";
export { nextOccurrence, presets } from "./schedule.ts";
