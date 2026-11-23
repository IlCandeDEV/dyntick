export const EXAM_SESSIONS = ["winter", "summer", "resit"] as const;
export type ExamSession = typeof EXAM_SESSIONS[number];

export const EXAM_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type ExamMonth = typeof EXAM_MONTHS[number];
export type SessionMonths = Record<ExamSession, readonly ExamMonth[]>;
export type MonthLabel = { month: ExamMonth; full: string; short: string };

export const DEFAULT_SESSION_MONTHS: Readonly<SessionMonths> = { winter: [1, 2], summer: [6, 7], resit: [9] };

export const MAX_EXAM_NAME_LENGTH = 80;
export const MAX_EXAM_CREDITS = 100;
export const CREDIT_SYSTEMS = ["CFU", "ECTS", "CATS"] as const;
export type CreditSystem = typeof CREDIT_SYSTEMS[number];
export const DATE_FORMATS = ["dmy", "mdy"] as const;
export type DateFormat = typeof DATE_FORMATS[number];

export function isCreditSystem(value: unknown): value is CreditSystem {
  return CREDIT_SYSTEMS.some((system) => system === value);
}

export function isDateFormat(value: unknown): value is DateFormat {
  return DATE_FORMATS.some((format) => format === value);
}

export interface Exam {
  id: string;
  name: string;
  academicYear: number;
  session: ExamSession | null;
  credits: number;
  examDate: string | null;
}

export type ExamPatch = Partial<Pick<Exam, "name" | "session" | "credits" | "examDate">>;

export type ExamAction =
  | { type: "exam.create"; exam: Omit<Exam, "credits" | "examDate"> & Partial<Pick<Exam, "credits" | "examDate">> }
  | { type: "exam.update"; id: string; patch: ExamPatch }
  | { type: "exam.delete"; id: string };

export type SessionMonthsAction = { type: "session.months"; session: ExamSession; months: readonly ExamMonth[] };
export type PlanningAction = ExamAction | SessionMonthsAction;

export function isExamSession(value: unknown): value is ExamSession {
  return EXAM_SESSIONS.some((session) => session === value);
}

export function isExamMonth(value: unknown): value is ExamMonth {
  return EXAM_MONTHS.some((month) => month === value);
}

export function isExamDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function formatExamDate(date: string, format: DateFormat): string {
  const [year, month, day] = date.split("-");
  return format === "mdy" ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
}

export function parseExamDate(input: string, format: DateFormat): string | null {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
  if (!parts) return null;
  const [, first, second, year] = parts;
  const [day, month] = format === "mdy" ? [second, first] : [first, second];
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isExamDate(date) ? date : null;
}

export function academicYearAt(date: Date): number {
  // September resits close the academic year that began the previous autumn.
  return date.getFullYear() - (date.getMonth() < 9 ? 1 : 0);
}

export function examMonthLabels(locale: string): MonthLabel[] {
  const full = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const short = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  return EXAM_MONTHS.map((month) => {
    const date = Date.UTC(2024, month - 1, 1);
    return { month, full: full.format(date), short: short.format(date) };
  });
}

export function formatSessionMonths(months: readonly ExamMonth[], labels: readonly MonthLabel[]): string {
  const ranges: string[][] = [];
  labels.forEach(({ month, short }, index) => {
    if (!months.includes(month)) return;
    if (index > 0 && months.includes(labels[index - 1].month)) ranges.at(-1)!.push(short);
    else ranges.push([short]);
  });
  return ranges.map((range) => range.length === 1 ? range[0] : `${range[0]}–${range.at(-1)}`).join(", ");
}
