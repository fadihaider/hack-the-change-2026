"use client";
// send a text: pick or type a number, let the model write a short draft, edit it, tick the approval for these exact
// words and this number, then send. nothing is saved or sent before the tick and the button that names the person.
import { useEffect, useId, useRef, useState } from "react";
import { MessageSquareText, Send, ShieldAlert, Sparkles } from "lucide-react";
import { liveErrorMessage } from "@/lib/frontend/live-api.ts";
import { RequestApiError } from "@/lib/frontend/request-api.ts";
import type { SmsRecipients, SmsRecipientChoice, SmsTier, SmsView } from "@/lib/frontend/sms-api.ts";
import { formatPhone, normalizePhone, smsParts } from "@/lib/sms/phone.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, Sheet, SheetTitle, TonePill, useAnnounce } from "../ui.tsx";
import { TierPicker } from "./TierPicker.tsx";
import { DELIVERY_LABEL, DELIVERY_TONE, deliveryNote } from "./smsWords.ts";
import { quoted } from "./words.ts";
import s from "./urgent.module.css";

type Props = {
  open: boolean;
  episodeId: string | null;
  /** the care recipient's alias ("Mom"), for the tier names */
  careAlias: string | null;
  /** RR_AI from the session: names the draft button honestly */
  aiMode: string;
  onClose: () => void;
  /** a text was approved or sent; the summary lists it with its status */
  onChange: (text: SmsView | null) => void;
};

type Busy = "draft" | "send" | null;

const FLAG_NOTE: Record<string, string> = {
  url: "It has a link. Some carriers filter texts with links.",
  email: "It has an email address in it.",
  phone: "It has a phone number in it. Check it’s the one you mean.",
  long: "It’s longer than two texts. Shorter reads better on a phone.",
};

function newKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function problem(error: unknown): string {
  if (error instanceof RequestApiError) {
    switch (error.code) {
      case "invalid_phone":
        return "Enter a 10-digit North American number, for example 403 555 0123.";
      case "demo_number_not_configured":
        return "The test phone isn’t set up. Add DEMO_SMS_TO to the server settings, or type a number.";
      case "rate_limited":
        return "That’s the most texts for this hour. Try again later.";
      case "verified_owner_required":
        return "Real texts need a verified sign-in on this address.";
      case "edit_needed":
        return "The text has formatting that can’t go in a text. Edit it and approve again.";
      case "not_configured":
        return "Texting isn’t set up on the server. Nothing was sent.";
      case "model_unavailable":
      case "model_needs_review":
        return "The draft couldn’t be written just now. Write it yourself, or try again.";
      default:
        break;
    }
    if (error.status === 409) return "This text already went, or changed. Its status is in the list.";
  }
  return liveErrorMessage(error);
}

export function SmsSheet({ open, episodeId, careAlias, aiMode, onClose, onChange }: Props) {
  const api = useApis().sms;
  const announce = useAnnounce();
  const titleId = useId();
  const ids = { note: useId(), body: useId(), sender: useId(), phone: useId(), name: useId(), approve: useId() };

  const [recipients, setRecipients] = useState<SmsRecipients | null>(null);
  const [choice, setChoice] = useState<string>("other");
  const [otherPhone, setOtherPhone] = useState("");
  const [otherName, setOtherName] = useState("");
  const [senderName, setSenderName] = useState("");
  const [note, setNote] = useState("");
  const [tier, setTier] = useState<SmsTier>("minimal");
  const [body, setBody] = useState("");
  const [flags, setFlags] = useState<string[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SmsView | null>(null);
  const clientKey = useRef(newKey());
  // the server copy approved for this exact key; a retry after a failed send reuses it instead of approving again
  const approvedText = useRef<{ key: string; text: SmsView } | null>(null);
  const lock = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setResult(null);
    setError(null);
    api
      .recipients()
      .then((list) => {
        if (!live) return;
        setRecipients(list);
        setChoice((current) => (current === "other" && list.options[0] ? optionKey(list.options[0]) : current));
        setSenderName((current) => current || list.senderName || "");
      })
      .catch((caught: unknown) => live && setError(problem(caught)));
    return () => {
      live = false;
    };
  }, [open, api]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  function optionKey(option: SmsRecipients["options"][number]): string {
    return option.kind === "demo" ? "demo" : `care:${option.id}`;
  }

  /** any change to what would be sent needs a fresh tick and a fresh approval */
  function changed() {
    setApproved(false);
    setResult(null);
    clientKey.current = newKey();
    approvedText.current = null;
  }

  const option = recipients?.options.find((o) => optionKey(o) === choice) ?? null;
  const typed = normalizePhone(otherPhone);
  const to: SmsRecipientChoice | null =
    choice === "other"
      ? typed
        ? { kind: "phone", phone: typed, label: otherName.trim() || undefined }
        : null
      : option?.kind === "demo"
        ? { kind: "demo" }
        : option?.id
          ? { kind: "care_contact", id: option.id }
          : null;
  const toName = choice === "other" ? otherName.trim() || "this number" : option?.label ?? "";
  const toNumber = choice === "other" ? (typed ? formatPhone(typed) : "") : option?.phoneMasked ?? "";
  const parts = smsParts(body.trim());
  const blocked = terms.length > 0 && tier !== "detailed" && !override;
  const live = recipients?.provider === "twilio";
  const draftLabel = aiMode === "gemini" ? "Write it with Gemini" : aiMode === "demo" ? "Write a draft (demo rules)" : "Write a draft";
  const canSend = to !== null && body.trim().length > 0 && approved && !blocked && busy === null;

  async function writeDraft() {
    if (lock.current) return;
    lock.current = true;
    setBusy("draft");
    setError(null);
    try {
      const recipientName = choice === "other" ? otherName.trim() || null : option?.kind === "care_contact" ? option.label : null;
      const draft = await api.draft({ episodeId, recipientName, senderName: senderName.trim() || null, note: note.trim() || null, tier });
      setBody(draft.text);
      setFlags(draft.editFlags);
      setTerms(draft.healthTermsFound);
      setOverride(false);
      changed();
      announce("The draft is ready. Read it and change anything before you approve it.");
    } catch (caught) {
      setError(problem(caught));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function send() {
    if (lock.current || !to || !canSend) return;
    lock.current = true;
    setBusy("send");
    setError(null);
    try {
      let text = approvedText.current?.key === clientKey.current ? approvedText.current.text : null;
      if (!text) {
        text = (
          await api.approve({
            clientKey: clientKey.current,
            episodeId,
            to,
            senderName: senderName.trim() || null,
            body: body.trim(),
            tier,
            healthOverride: override,
          })
        ).text;
        approvedText.current = { key: clientKey.current, text };
        onChange(text);
      }
      const sent = (await api.send(text.id)).text;
      setResult(sent);
      onChange(sent);
      announce(`${DELIVERY_LABEL[sent.delivery]}. ${deliveryNote(sent)}`);
    } catch (caught) {
      if (caught instanceof RequestApiError && caught.code === "health_terms") {
        setTerms(caught.terms);
        setError(null);
      } else {
        setError(problem(caught));
        if (caught instanceof RequestApiError && caught.status === 409) onChange(null);
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} labelledBy={titleId}>
      <div className={s.sheetHead}>
        <TonePill tone={live ? "ask" : "warn"}>{live ? "Real text" : "Demo · not delivered"}</TonePill>
        <SheetTitle id={titleId}>Send a text</SheetTitle>
      </div>
      <p className={s.sheetLead}>
        Pick who gets it and say what they should know. Read the draft, change anything, then approve these exact words.
      </p>

      <div className={s.smsFields}>
        <fieldset className={s.smsTo} disabled={busy !== null}>
          <legend className={s.privacyTitle}>Who gets it</legend>
          {(recipients?.options ?? []).map((o) => {
            const key = optionKey(o);
            return (
              <label key={key} className={s.tierOption}>
                <input
                  type="radio"
                  name={`${titleId}-to`}
                  className={s.tierRadio}
                  checked={choice === key}
                  onChange={() => {
                    setChoice(key);
                    changed();
                  }}
                />
                <span className={s.tierText}>
                  <span className={s.tierName}>{o.label}</span>
                  <span className={s.tierHint}>
                    {o.phoneMasked}
                    {o.detail && o.kind === "care_contact" ? ` · ${o.detail}` : ""}
                  </span>
                </span>
              </label>
            );
          })}
          <label className={s.tierOption}>
            <input
              type="radio"
              name={`${titleId}-to`}
              className={s.tierRadio}
              checked={choice === "other"}
              onChange={() => {
                setChoice("other");
                changed();
              }}
            />
            <span className={s.tierText}>
              <span className={s.tierName}>Another number</span>
              <span className={s.tierHint}>A Canadian or US mobile number</span>
            </span>
          </label>
          {choice === "other" && (
            <div className={s.smsOther}>
              <div>
                <label htmlFor={ids.phone} className={s.smsInputLabel}>
                  Phone number
                </label>
                <input
                  id={ids.phone}
                  className={s.smsInput}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="403 555 0123"
                  maxLength={32}
                  value={otherPhone}
                  aria-invalid={otherPhone.trim() !== "" && !typed ? true : undefined}
                  onChange={(event) => {
                    setOtherPhone(event.target.value);
                    changed();
                  }}
                />
                {otherPhone.trim() !== "" && !typed && (
                  <p className={s.smsCount}>Enter 10 digits, for example 403 555 0123.</p>
                )}
              </div>
              <div>
                <label htmlFor={ids.name} className={s.smsInputLabel}>
                  Their name (optional)
                </label>
                <input
                  id={ids.name}
                  className={s.smsInput}
                  maxLength={60}
                  value={otherName}
                  onChange={(event) => {
                    setOtherName(event.target.value);
                    changed();
                  }}
                />
              </div>
            </div>
          )}
        </fieldset>

        <div>
          <label htmlFor={ids.sender} className={s.smsInputLabel}>
            Sign it as
          </label>
          <input
            id={ids.sender}
            className={s.smsInput}
            maxLength={60}
            value={senderName}
            disabled={busy !== null}
            onChange={(event) => {
              setSenderName(event.target.value);
              changed();
            }}
          />
        </div>

        <div>
          <label htmlFor={ids.note} className={s.smsInputLabel}>
            What should they know?
          </label>
          <textarea
            id={ids.note}
            className={s.smsInput}
            rows={3}
            maxLength={500}
            placeholder="For example: I’m going through something difficult and won’t be reachable for the next seven days."
            value={note}
            disabled={busy !== null}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      <div className={s.privacy}>
        <TierPicker
          value={tier}
          groupTier={undefined}
          alias={careAlias}
          disabled={busy !== null}
          onChange={(next) => {
            setTier(next);
            changed();
          }}
        />
      </div>

      <div className={s.sendArea}>
        <Button variant="secondary" busy={busy === "draft"} busyLabel="Writing the draft" disabled={busy === "send"} onClick={() => void writeDraft()}>
          <Sparkles size={18} aria-hidden="true" />
          {body ? "Write it again" : draftLabel}
        </Button>
      </div>

      <div className={`${s.paper} ${s.space}`}>
        <div className={s.letterRow}>
          <span className={s.letterLabel}>To</span>
          <div className={s.letterValue}>
            <span className={s.toName}>{toName || "Pick someone above"}</span>
            {toNumber && <span className={s.toEmail}>{toNumber}</span>}
          </div>
        </div>
        <div className={s.bodyBlock}>
          <label htmlFor={ids.body} className={s.letterLabel}>
            Text message
          </label>
          <textarea
            id={ids.body}
            className={s.body}
            style={{ minHeight: 140 }}
            rows={5}
            maxLength={1600}
            value={body}
            placeholder="Write it here, or use the button above for a draft."
            readOnly={busy !== null}
            onChange={(event) => {
              setBody(event.target.value);
              setTerms([]);
              setOverride(false);
              changed();
            }}
          />
          <p className={s.smsCount} aria-live="polite">
            {parts.chars} characters · {parts.parts === 1 ? "1 text" : `${parts.parts} texts`}
            {parts.encoding === "unicode" && parts.chars > 0 ? " (special characters make each text shorter)" : ""}
          </p>
        </div>
      </div>

      {flags.filter((flag) => FLAG_NOTE[flag]).length > 0 && (
        <ul className={s.flags} role="list">
          {flags.filter((flag) => FLAG_NOTE[flag]).map((flag) => (
            <li key={flag}>{FLAG_NOTE[flag]}</li>
          ))}
        </ul>
      )}

      {terms.length > 0 && tier !== "detailed" && (
        <div className={s.warn} role="group" aria-labelledby={`${titleId}-warn`}>
          <p id={`${titleId}-warn`} className={s.warnTitle}>
            <ShieldAlert size={20} aria-hidden="true" />
            <span>This text mentions {quoted(terms)}.</span>
          </p>
          <p className={s.warnText}>Health details stay private unless you choose to share them. Edit them out, or send it as written.</p>
          <label className={s.tierOption}>
            <input
              type="checkbox"
              className={s.tierRadio}
              checked={override}
              onChange={(event) => {
                setOverride(event.target.checked);
                changed();
              }}
            />
            <span className={s.tierText}>
              <span className={s.tierName}>Send it with these words</span>
            </span>
          </label>
        </div>
      )}

      <label className={s.smsApprove} htmlFor={ids.approve}>
        <input
          id={ids.approve}
          type="checkbox"
          className={s.tierRadio}
          checked={approved}
          disabled={to === null || body.trim().length === 0 || busy !== null}
          onChange={(event) => setApproved(event.target.checked)}
        />
        <span>
          I approve sending exactly this text to <strong>{toName || "…"}</strong>
          {toNumber ? ` at ${toNumber}` : ""}.
        </span>
      </label>

      {error && (
        <div className={s.space} ref={errorRef}>
          <ErrorNote message={error} />
        </div>
      )}

      {result ? (
        <div className={s.smsResult} role="status">
          <TonePill tone={DELIVERY_TONE[result.delivery]}>{DELIVERY_LABEL[result.delivery]}</TonePill>
          <p className={s.smsResultNote}>{deliveryNote(result)}</p>
          {result.providerMessageId && <p className={s.smsRef}>Message ID {result.providerMessageId}</p>}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className={s.sendArea}>
          <Button
            variant="primary"
            busy={busy === "send"}
            busyLabel={`Sending to ${toName}`}
            disabled={!canSend && busy !== "send"}
            onClick={() => void send()}
          >
            <Send size={18} aria-hidden="true" />
            Send SMS{toName ? ` to ${toName}` : ""}
          </Button>
        </div>
      )}

      <p className={s.sendNote}>
        <MessageSquareText size={14} aria-hidden="true" />{" "}
        {live
          ? "Sends a real text through Twilio from the app’s number. Each send needs your approval."
          : "Twilio isn’t set up, so this goes to the demo text outbox. Nothing is delivered."}
      </p>
    </Sheet>
  );
}
