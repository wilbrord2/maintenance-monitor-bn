export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function addHours(date: Date, hours: number): Date {
  return addSeconds(date, hours * 3600);
}
