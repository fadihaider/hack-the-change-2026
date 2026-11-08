// phone numbers for texts: North American (+1) numbers only, the Canadian demo's reach, stored as E.164
// shared by the server and the browser, so it imports nothing server-only

/** "+14035550123" from "403-555-0123", "(403) 555 0123", "1 403 555 0123" or "+1 403 555 0123"; null when not +1 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 32 || /[^\d\s().+-]/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (trimmed.startsWith("+") && !(digits.length === 11 && digits.startsWith("1"))) return null;
  // NANP: area code and exchange both start 2 to 9
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

/** "(403) 555-0123" for an E.164 +1 number; any other value is returned unchanged */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : e164;
}

/** "(•••) •••-0123": enough to recognise a number without showing it */
export function maskPhone(e164: string): string {
  const last = e164.replace(/\D/g, "").slice(-4);
  return last.length === 4 ? `(•••) •••-${last}` : "a hidden number";
}

/**
 * GSM-7 texts split into 153-character parts after 160, anything else (curly quotes, emoji, accents outside the GSM
 * set) into 67-character parts after 70. An estimate for the counter only; the carrier decides.
 */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;

export function smsParts(text: string): { encoding: "gsm" | "unicode"; parts: number; chars: number } {
  const chars = [...text].length;
  const encoding = GSM7.test(text) ? "gsm" : "unicode";
  const [single, multi] = encoding === "gsm" ? [160, 153] : [70, 67];
  return { encoding, chars, parts: chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi) };
}
