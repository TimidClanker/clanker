import { Type, type Static } from '@earendil-works/pi-ai'

export const When = Type.Union([
  Type.Object({ kind: Type.Literal('once'), at: Type.String({ description: 'ISO timestamp with an explicit UTC offset, e.g. 2026-10-05T09:00:00-04:00.' }) }),
  Type.Object({ kind: Type.Literal('delay'), seconds: Type.Integer({ minimum: 1 }) }),
  Type.Object({ kind: Type.Literal('interval'), seconds: Type.Integer({ minimum: 60 }) }),
  Type.Object({
    kind: Type.Literal('calendar'),
    time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Local time, HH:mm.' }),
    timeZone: Type.String({ description: 'IANA time zone, e.g. America/New_York.' }),
    weekdays: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
        minItems: 1,
        uniqueItems: true,
        description: 'Monday=1 through Sunday=7; omitted means every day.'
      })
    )
  })
])

export type Timing = { firstAt: number; repeat?: Extract<Static<typeof When>, { kind: 'interval' | 'calendar' }> }

export function nextOccurrence(timing: Timing, after: number): number | undefined {
  const repeat = timing.repeat
  if (!repeat) return undefined
  if (repeat.kind === 'interval') {
    const interval = repeat.seconds * 1000
    return timing.firstAt + (Math.floor((after - timing.firstAt) / interval) + 1) * interval
  }
  let date = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(repeat.timeZone).toPlainDate()
  for (let day = 0; day < 8; day++, date = date.add({ days: 1 })) {
    if (repeat.weekdays && !repeat.weekdays.includes(date.dayOfWeek)) continue
    // Temporal's compatible disambiguation shifts spring gaps forward and picks the first autumn occurrence.
    const at = date.toPlainDateTime(repeat.time).toZonedDateTime(repeat.timeZone, { disambiguation: 'compatible' }).epochMilliseconds
    if (at > after) return at
  }
  throw new Error('No next occurrence for this schedule')
}

export function resolveTiming(when: Static<typeof When>, now: number): Timing {
  const timing: Timing =
    when.kind === 'once'
      ? { firstAt: Temporal.Instant.from(when.at).epochMilliseconds }
      : when.kind === 'calendar'
        ? { firstAt: 0, repeat: when }
        : { firstAt: now + when.seconds * 1000, ...(when.kind === 'interval' ? { repeat: when } : {}) }
  if (when.kind === 'calendar') timing.firstAt = nextOccurrence(timing, now)!
  if (!Number.isSafeInteger(timing.firstAt) || timing.firstAt <= now) throw new Error('The first occurrence must be a valid future time')
  Temporal.Instant.fromEpochMilliseconds(timing.firstAt)
  return timing
}
