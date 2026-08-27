export const EVERYDAY_DELIVERY_DAYS = 0b11111_11;
export const WORK_DELIVERY_DAYS = 0b11111_00;
export const WEEKEND_DELIVERY_DAYS = 0b00000_11;

const DAY_BITS: Record<string, number> = {
  Mon: 0b10000_00,
  Tue: 0b01000_00,
  Wed: 0b00100_00,
  Thu: 0b00010_00,
  Fri: 0b00001_00,
  Sat: 0b00000_10,
  Sun: 0b00000_01,
};

export function assertDeliveryDaysMask(mask: number): void {
  if (!Number.isInteger(mask) || mask < 0 || mask > EVERYDAY_DELIVERY_DAYS) {
    throw new Error(`Delivery days mask must use only the low seven bits, got ${mask}`);
  }
}

export function parseDeliveryDays(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized === "everyday") return EVERYDAY_DELIVERY_DAYS;
  if (normalized === "work") return WORK_DELIVERY_DAYS;
  if (normalized === "weekend") return WEEKEND_DELIVERY_DAYS;

  // Human-readable order is Monday through Sunday: five workdays, an
  // underscore, then the two weekend days. The quote and underscore are
  // optional so both 7b'10101_10 and 7b1010110 are accepted by shells.
  const custom = /^7b'?([01]{5})_?([01]{2})'?$/.exec(normalized);
  if (!custom) {
    throw new Error("Delivery days must be everyday, work, weekend, or a Monday-Sunday mask such as 7b'11111_00");
  }
  return Number.parseInt(`${custom[1]}${custom[2]}`, 2);
}

export function formatDeliveryDays(mask: number): string {
  assertDeliveryDaysMask(mask);
  if (mask === EVERYDAY_DELIVERY_DAYS) return "everyday";
  if (mask === WORK_DELIVERY_DAYS) return "work";
  if (mask === WEEKEND_DELIVERY_DAYS) return "weekend";
  const bits = mask.toString(2).padStart(7, "0");
  return `7b'${bits.slice(0, 5)}_${bits.slice(5)}`;
}

export function deliveryDayBit(date: Date, timeZone = "Asia/Singapore"): number {
  if (Number.isNaN(date.getTime())) throw new Error("Cannot determine delivery day from an invalid date");
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const bit = DAY_BITS[weekday];
  if (!bit) throw new Error(`Unsupported weekday: ${weekday}`);
  return bit;
}
