// Dates travel as ISO "YYYY-MM-DD" strings in the LOCAL time zone.
// (new Date().toISOString() would give UTC and can be off by a day for UTC+8.)

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-20" -> "20 Sep 2026". Returns the input unchanged if it isn't ISO.
 *  (Fixed month names on purpose: Intl gives "Sept" or "Sep" depending on the browser's ICU version.) */
export function formatDisplay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
