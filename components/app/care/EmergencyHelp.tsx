"use client";
// emergency / help (PRD 9): 911 and 811 as static tel: links that never wait on data or a model,
// then only the contacts the caregiver typed in. nothing dials or sends until a link is tapped.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LifeBuoy, Phone, Plus, Siren, Stethoscope } from "lucide-react";
import { liveErrorMessage, type CareContactView } from "@/lib/frontend/live-api.ts";
import {
  CONTACT_LIMITS,
  EMERGENCY_LINES,
  checkContactDraft,
  orderContacts,
  telHref,
  type ContactDraft,
} from "@/lib/frontend/care-help.ts";
import { useApis } from "../session.tsx";
import { Button, ErrorNote, Sheet, SheetTitle, VisuallyHidden, useAnnounce } from "../ui.tsx";
import { possessive } from "./care-data.ts";
import e from "./emergency.module.css";

export type EmergencyHelpProps = {
  /** the care recipient's name, for copy */
  name: string;
  /** "header": the compact button at the top of Care; "inline": the block inside the passport Contacts section */
  placement?: "header" | "inline";
};

export function EmergencyHelp({ name, placement = "header" }: EmergencyHelpProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);

  if (placement === "inline") {
    return (
      <section className={e.inline} aria-labelledby={titleId}>
        <h3 id={titleId} className={e.inlineTitle}>
          Emergency / Help
        </h3>
        <HelpContent name={name} sub="h4" />
      </section>
    );
  }

  return (
    <>
      <button type="button" className={e.trigger} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <LifeBuoy size={18} aria-hidden="true" />
        Emergency / Help
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} labelledBy={titleId} closeLabel="Close emergency help">
        <SheetTitle id={titleId}>Emergency / Help</SheetTitle>
        <HelpContent name={name} sub="h3" />
      </Sheet>
    </>
  );
}

type Heading = "h3" | "h4";

function HelpContent({ name, sub: Sub }: { name: string; sub: Heading }) {
  return (
    <div className={e.content}>
      <div className={e.services}>
        <div className={`${e.service} ${e.serviceEmergency}`}>
          <Sub className={e.serviceTitle}>
            <Siren size={20} aria-hidden="true" />
            Emergency — call 911
          </Sub>
          <p className={e.serviceText}>
            In Calgary, call 911 now if {name} is in immediate danger, can’t breathe, has chest pain or isn’t responding.
          </p>
          <a className={`${e.call} ${e.callEmergency}`} href={EMERGENCY_LINES.emergency.href}>
            <Phone size={20} aria-hidden="true" />
            Call 911
          </a>
        </div>
        <div className={e.service}>
          <Sub className={e.serviceTitle}>
            <Stethoscope size={20} aria-hidden="true" />
            Health Link — call 811
          </Sub>
          <p className={e.serviceText}>
            For health questions that aren’t emergencies, Health Link nurses give advice 24/7 anywhere in Alberta.
          </p>
          <a className={e.call} href={EMERGENCY_LINES.healthLink.href}>
            <Phone size={20} aria-hidden="true" />
            Call 811
          </a>
        </div>
        <p className={e.footnote}>Nothing dials or sends until you tap a number.</p>
      </div>

      <TrustedContacts name={name} sub={Sub} />
    </div>
  );
}

const EMPTY_DRAFT: ContactDraft = { name: "", relationship: "", phone: "", kind: "emergency" };
const KIND_LABEL: Record<CareContactView["kind"], string> = {
  emergency: "Emergency contact",
  trusted: "Trusted helper",
};

function TrustedContacts({ name, sub: Sub }: { name: string; sub: Heading }) {
  const { live } = useApis();
  const announce = useAnnounce();
  const titleId = useId();
  const formId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [contacts, setContacts] = useState<CareContactView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(null);
    try {
      const { contacts: rows } = await live.careContacts();
      if (mine === seq.current) setContacts(rows);
    } catch (caught) {
      if (mine === seq.current) setLoadError(liveErrorMessage(caught));
    }
  }, [live]);

  useEffect(() => {
    void load();
    return () => {
      seq.current += 1;
    };
  }, [load]);

  const ordered = contacts ? orderContacts(contacts) : [];

  function added(contact: CareContactView) {
    setContacts((rows) => [...(rows ?? []), contact]);
    setAdding(false);
    announce(`Added ${contact.name} to your trusted contacts.`);
    window.requestAnimationFrame(() => toggleRef.current?.focus());
  }

  function removed(contact: CareContactView) {
    setContacts((rows) => (rows ?? []).filter((row) => row.id !== contact.id));
    announce(`Removed ${contact.name} from your trusted contacts.`);
    window.requestAnimationFrame(() => titleRef.current?.focus());
  }

  return (
    <section className={e.contacts} aria-labelledby={titleId} aria-busy={contacts === null && !loadError}>
      <Sub id={titleId} ref={titleRef} tabIndex={-1} className={e.contactsTitle}>
        Your trusted contacts
      </Sub>
      <p className={e.contactsHint}>
        Only people you add here. ReliefReady never calls or messages them for you.
      </p>

      {loadError ? (
        <div className={e.block}>
          <ErrorNote message={loadError} onRetry={() => void load()} retryLabel="Load contacts again" />
        </div>
      ) : contacts === null ? (
        <p className={e.muted}>Loading your contacts…</p>
      ) : ordered.length === 0 ? (
        <p className={e.empty}>No contacts added yet.</p>
      ) : (
        <ul className={e.contactList} role="list">
          {ordered.map((contact) => (
            <ContactRow key={contact.id} name={name} contact={contact} onRemoved={removed} />
          ))}
        </ul>
      )}

      {contacts !== null && !loadError && (
        <>
          <button
            ref={toggleRef}
            type="button"
            className={e.addToggle}
            aria-expanded={adding}
            aria-controls={adding ? formId : undefined}
            onClick={() => setAdding((now) => !now)}
          >
            <Plus size={18} aria-hidden="true" />
            Add a contact
          </button>
          {adding && (
            <ContactForm
              id={formId}
              name={name}
              onAdded={added}
              onCancel={() => {
                setAdding(false);
                window.requestAnimationFrame(() => toggleRef.current?.focus());
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function ContactRow({
  name,
  contact,
  onRemoved,
}: {
  name: string;
  contact: CareContactView;
  onRemoved: (contact: CareContactView) => void;
}) {
  const { live } = useApis();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const href = telHref(contact.phone);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await live.removeCareContact(contact.id);
      onRemoved(contact);
    } catch (caught) {
      setError(liveErrorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <li className={e.contact}>
      <div className={e.contactWho}>
        <p className={e.contactName}>{contact.name}</p>
        <p className={e.contactMeta}>
          {contact.kind === "emergency" && <span className={e.badge}>{KIND_LABEL.emergency}</span>}
          {contact.kind === "trusted" && <span>{KIND_LABEL.trusted}</span>}
          {contact.relationship && <span>{contact.relationship}</span>}
        </p>
      </div>
      {href ? (
        <a className={e.contactCall} href={href}>
          <Phone size={18} aria-hidden="true" />
          <span>
            <VisuallyHidden>Call {contact.name}, </VisuallyHidden>
            {contact.phone}
          </span>
        </a>
      ) : (
        <p className={e.contactPhone}>{contact.phone}</p>
      )}

      {confirming ? (
        <div className={e.confirm} role="group" aria-label={`Remove ${contact.name}?`}>
          <p className={e.confirmText}>
            Remove {contact.name} from {possessive(name)} contacts? This only changes ReliefReady.
          </p>
          <div className={e.confirmActions}>
            <Button variant="secondary" className={e.removeYes} busy={busy} busyLabel="Removing" onClick={() => void remove()}>
              Remove
            </Button>
            <Button
              ref={keepRef}
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setError(null);
                window.requestAnimationFrame(() => removeRef.current?.focus());
              }}
            >
              Keep
            </Button>
          </div>
          {error && <ErrorNote message={error} />}
        </div>
      ) : (
        <button ref={removeRef} type="button" className={e.removeLink} onClick={() => setConfirming(true)}>
          Remove<VisuallyHidden> {contact.name}</VisuallyHidden>
        </button>
      )}
    </li>
  );
}

type FieldError = { field: "name" | "relationship" | "phone"; message: string };

function ContactForm({
  id,
  name,
  onAdded,
  onCancel,
}: {
  id: string;
  name: string;
  onAdded: (contact: CareContactView) => void;
  onCancel: () => void;
}) {
  const { live } = useApis();
  const uid = useId();
  const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const relationshipRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const refs = { name: nameRef, relationship: relationshipRef, phone: phoneRef };

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function set<K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (fieldError?.field === key) setFieldError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const checked = checkContactDraft(draft);
    if (!checked.ok) {
      setFieldError({ field: checked.field, message: checked.message });
      refs[checked.field].current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const { contact } = await live.addCareContact(checked.value);
      onAdded(contact);
    } catch (caught) {
      setError(liveErrorMessage(caught));
      setBusy(false);
    }
  }

  const errorId = (field: FieldError["field"]) => (fieldError?.field === field ? `${uid}-${field}-error` : undefined);
  const describe = (...ids: (string | undefined)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <form id={id} className={e.form} onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
      <p id={`${uid}-title`} className={e.formTitle}>
        Add someone you trust to help {name}
      </p>

      <div className={e.field}>
        <label htmlFor={`${uid}-name`} className={e.label}>
          Name
        </label>
        <input
          ref={nameRef}
          id={`${uid}-name`}
          className={e.input}
          type="text"
          autoComplete="off"
          maxLength={CONTACT_LIMITS.name}
          value={draft.name}
          readOnly={busy}
          aria-invalid={fieldError?.field === "name" || undefined}
          aria-describedby={errorId("name")}
          onChange={(event) => set("name", event.target.value)}
        />
        {fieldError?.field === "name" && (
          <p id={errorId("name")} className={e.fieldError}>
            {fieldError.message}
          </p>
        )}
      </div>

      <div className={e.field}>
        <label htmlFor={`${uid}-relationship`} className={e.label}>
          Relationship <span className={e.optional}>(optional)</span>
        </label>
        <p id={`${uid}-relationship-hint`} className={e.hint}>
          For example: daughter, neighbour, family doctor
        </p>
        <input
          ref={relationshipRef}
          id={`${uid}-relationship`}
          className={e.input}
          type="text"
          autoComplete="off"
          maxLength={CONTACT_LIMITS.relationship}
          value={draft.relationship}
          readOnly={busy}
          aria-invalid={fieldError?.field === "relationship" || undefined}
          aria-describedby={describe(`${uid}-relationship-hint`, errorId("relationship"))}
          onChange={(event) => set("relationship", event.target.value)}
        />
        {fieldError?.field === "relationship" && (
          <p id={errorId("relationship")} className={e.fieldError}>
            {fieldError.message}
          </p>
        )}
      </div>

      <div className={e.field}>
        <label htmlFor={`${uid}-phone`} className={e.label}>
          Phone number
        </label>
        <p id={`${uid}-phone-hint`} className={e.hint}>
          For example: 403-555-0142
        </p>
        <input
          ref={phoneRef}
          id={`${uid}-phone`}
          className={e.input}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          maxLength={CONTACT_LIMITS.phone}
          value={draft.phone}
          readOnly={busy}
          aria-invalid={fieldError?.field === "phone" || undefined}
          aria-describedby={describe(`${uid}-phone-hint`, errorId("phone"))}
          onChange={(event) => set("phone", event.target.value)}
        />
        {fieldError?.field === "phone" && (
          <p id={errorId("phone")} className={e.fieldError}>
            {fieldError.message}
          </p>
        )}
      </div>

      <fieldset className={e.kinds}>
        <legend className={e.label}>When to call them</legend>
        <label className={e.kind}>
          <input
            type="radio"
            name={`${uid}-kind`}
            value="emergency"
            checked={draft.kind === "emergency"}
            disabled={busy}
            onChange={() => set("kind", "emergency")}
          />
          <span>
            <span className={e.kindTitle}>{KIND_LABEL.emergency}</span>
            <span className={e.kindHint}>Call first in an emergency, after 911</span>
          </span>
        </label>
        <label className={e.kind}>
          <input
            type="radio"
            name={`${uid}-kind`}
            value="trusted"
            checked={draft.kind === "trusted"}
            disabled={busy}
            onChange={() => set("kind", "trusted")}
          />
          <span>
            <span className={e.kindTitle}>{KIND_LABEL.trusted}</span>
            <span className={e.kindHint}>Can help out or take a shift</span>
          </span>
        </label>
      </fieldset>

      {error && <ErrorNote message={error} />}

      <div className={e.formActions}>
        <Button type="submit" variant="primary" busy={busy} busyLabel="Saving">
          Save contact
        </Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
