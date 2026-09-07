// =============================================================================
// sms_text.ts — what a message will actually cost before you send it
// =============================================================================
// Carriers bill per SEGMENT, not per message, and the segment size depends on
// the alphabet: 160 characters of GSM-7, but only 70 if a single character
// falls outside it. An em-dash, a curly quote from a phone keyboard, or one
// emoji doubles the bill on every recipient — silently, because nothing in the
// send path complains.
//
// So the composer counts segments live and normalizes the usual offenders
// rather than lecturing a volunteer about character encodings.
// =============================================================================

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';   // these cost two characters each

const GSM = new Set(GSM_BASIC);
const EXT = new Set(GSM_EXT);

/** Swap characters phones insert automatically for their plain equivalents. */
export function normalizeForSms(input: string): string {
  return String(input ?? '')
    .replace(/[‘’‛]/g, "'")     // curly single quotes
    .replace(/[“”]/g, '"')           // curly double quotes
    .replace(/[–—−]/g, '-')     // en/em dash, minus
    .replace(/…/g, '...')                 // ellipsis
    .replace(/ /g, ' ')                   // non-breaking space
    .replace(/[•·]/g, '-')           // bullets
    .replace(/→/g, '>');                  // arrow
}

export type SmsMeasure = {
  chars: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  /** Characters outside GSM-7 that are forcing the expensive encoding. */
  offenders: string[];
  /** Characters still available before the next segment starts. */
  remaining: number;
};

export function measureSms(raw: string): SmsMeasure {
  const text = String(raw ?? '');
  const offenders = [...new Set([...text].filter(c => !GSM.has(c) && !EXT.has(c)))];

  if (offenders.length === 0) {
    // Extended characters occupy two slots each.
    const units = [...text].reduce((n, c) => n + (EXT.has(c) ? 2 : 1), 0);
    const segments = units <= 160 ? 1 : Math.ceil(units / 153);
    const capacity = segments === 1 ? 160 : segments * 153;
    return { chars: units, segments, encoding: 'GSM-7', offenders, remaining: capacity - units };
  }
  // UCS-2 is billed in UTF-16 CODE UNITS, not code points. An emoji outside
  // the BMP is a surrogate pair and costs two. [...text].length counts code
  // points, so it reported 36 emoji as 36 units (one segment) where Twilio
  // bills 72 units (two) — undercounting exactly the messages most likely to
  // be emoji-heavy. String.length is the UTF-16 unit count.
  const n = text.length;
  const segments = n <= 70 ? 1 : Math.ceil(n / 67);
  const capacity = segments === 1 ? 70 : segments * 67;
  return { chars: n, segments, encoding: 'UCS-2', offenders, remaining: capacity - n };
}

/** Roughly what a send costs, in cents, at the current US Twilio rate. */
export function estimateCostCents(recipients: number, segments: number): number {
  const PER_SEGMENT_CENTS = 0.83;
  return Math.ceil(recipients * segments * PER_SEGMENT_CENTS);
}

/** What members see: "Club name: your message". Kept identical everywhere so
 *  the composer's counter matches what actually goes out. */
export function renderBlast(clubName: string, body: string): string {
  return `${clubName}: ${normalizeForSms(body)}`;
}
