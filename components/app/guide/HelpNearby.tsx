"use client";
// help nearby: the cards /api/guide returns (leave rule, EI, supports, hospital, pharmacy, transit), each with its
// source link and the date it was checked. one small question about time at work re-queries the leave card.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  BriefcaseBusiness,
  Bus,
  Copy,
  ExternalLink,
  HandHeart,
  Hospital,
  Landmark,
  MapPin,
  Pill,
  type LucideIcon,
} from "lucide-react";
import { liveErrorMessage, safeHref, type GuideCardView, type GuideView, type Tenure } from "@/lib/frontend/live-api.ts";
import { RequestApiError } from "@/lib/frontend/request-api.ts";
import { useApis, useSession } from "../session.tsx";
import { Button, ErrorNote, VisuallyHidden, useAnnounce } from "../ui.tsx";
import s from "./guide.module.css";

const ICONS: Record<string, LucideIcon> = {
  leave: BriefcaseBusiness,
  ei: Landmark,
  support: HandHeart,
  hospital: Hospital,
  pharmacy: Pill,
  transit: Bus,
};

type GroupKey = "near" | "work" | "support" | "other";

const GROUP_OF: Record<string, GroupKey> = {
  hospital: "near",
  pharmacy: "near",
  transit: "near",
  leave: "work",
  ei: "work",
  support: "support",
};

const TENURE_CHOICES: { value: Tenure; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

// the first few supports show at once; the rest wait behind one quiet button
const SUPPORTS_SHOWN = 3;
const ADDRESS_MAX = 200;

export function HelpNearby({ address }: { address: string | null }) {
  const { live } = useApis();
  const { session } = useSession();
  const announce = useAnnounce();
  const uid = useId();
  const headingId = `${uid}-help`;
  const tenureId = `${uid}-tenure`;
  const fieldId = `${uid}-address`;

  const [tenure, setTenure] = useState<Tenure>("not_sure");
  // an address typed here after a lookup problem; it belongs to the address prop it replaced
  const [typed, setTyped] = useState<{ for: string | null; value: string } | null>(null);
  const [draft, setDraft] = useState(address ?? "");
  const [attempt, setAttempt] = useState(0);
  const [guide, setGuide] = useState<GuideView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locationProblem, setLocationProblem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [allSupports, setAllSupports] = useState(false);
  const seq = useRef(0);
  const spoken = useRef<string | null>(null);
  // after a typed address works, the address form goes away; focus moves to the section heading instead
  const refocus = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const query = typed && typed.for === address ? typed.value : (address ?? "");
  // pharmacy hours are checked at app time, so a moved demo clock asks again
  const appNow = session?.appNow ?? null;

  useEffect(() => {
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    live
      .guide(query, tenure)
      .then((next) => {
        if (mine !== seq.current) return;
        setGuide(next);
        setError(null);
        setLocationProblem(false);
        if (spoken.current) announce(spoken.current);
        if (refocus.current) {
          refocus.current = false;
          window.requestAnimationFrame(() => headingRef.current?.focus());
        }
      })
      .catch((caught: unknown) => {
        if (mine !== seq.current) return;
        const message = liveErrorMessage(caught);
        setError(message);
        setLocationProblem(caught instanceof RequestApiError && caught.status === 422);
        if (spoken.current) announce(message);
        refocus.current = false;
      })
      .finally(() => {
        if (mine !== seq.current) return;
        setLoading(false);
        spoken.current = null;
      });
  }, [live, query, tenure, appNow, attempt, announce]);

  function chooseTenure(next: Tenure) {
    if (next === tenure) return;
    spoken.current =
      next === "no"
        ? "Updated. The family leave rule is hidden, because it needs 90 days with the same employer."
        : "Updated the help list.";
    setTenure(next);
  }

  function lookUp(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    spoken.current = "Updated the help list.";
    refocus.current = true;
    setTyped({ for: address, value });
    setAttempt((n) => n + 1);
  }

  const cards = guide?.cards ?? [];
  const grouped = groupCards(cards);
  const community = guide ? placeName(guide.location.community) : null;
  const usesOsm = cards.some((card) => card.source.includes("OpenStreetMap") || card.sourceUrl.includes("openstreetmap"));
  const supports = grouped.support;
  const shownSupports = allSupports ? supports : supports.slice(0, SUPPORTS_SHOWN);
  const hiddenSupports = supports.length - shownSupports.length;
  const firstExtraId = `${uid}-support-${SUPPORTS_SHOWN}`;

  return (
    <section className={s.section} aria-labelledby={headingId} aria-busy={loading || undefined}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className={s.title}>
        Help nearby
      </h2>
      <p className={s.lead}>
        {community
          ? `Around ${community} in Calgary, from public sources. Each card says where it came from and when it was checked.`
          : "Hospitals, pharmacies, transit, time off work and support, from public sources."}
      </p>

      {!guide && loading && (
        <p className={s.loading} role="status">
          Finding help nearby
        </p>
      )}

      {error && (
        <div className={s.problem}>
          <ErrorNote
            message={error}
            onRetry={locationProblem ? undefined : () => setAttempt((n) => n + 1)}
          />
          {locationProblem && (
            <form className={s.addressForm} onSubmit={lookUp}>
              <label htmlFor={fieldId} className={s.label}>
                Calgary address
              </label>
              <input
                id={fieldId}
                className={s.input}
                type="text"
                value={draft}
                maxLength={ADDRESS_MAX}
                autoComplete="street-address"
                placeholder="800 3 St SE"
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" variant="secondary" busy={loading} busyLabel="Looking it up">
                Find help near this address
              </Button>
            </form>
          )}
        </div>
      )}

      {guide && (
        <div className={s.groups}>
          {grouped.near.length > 0 && (
            <CardGroup title={community ? `Close to ${community}` : "Close by"} cards={grouped.near} idBase={`${uid}-near`} />
          )}

          <div className={s.group}>
            <h3 className={s.groupTitle}>Time off and income</h3>
            <fieldset className={s.tenure} aria-describedby={`${tenureId}-hint`}>
              <legend className={s.tenureAsk}>Have you worked at your job for 90 days or more?</legend>
              <div className={s.toggles}>
                {TENURE_CHOICES.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className={s.toggle}
                    aria-pressed={tenure === choice.value}
                    onClick={() => chooseTenure(choice.value)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              <p id={`${tenureId}-hint`} className={s.hint}>
                {tenure === "no"
                  ? "Alberta’s job-protected family leave needs 90 days with the same employer, so it isn’t shown. Your employer may still agree to time off."
                  : "This only changes whether the job-protected leave shows. It doesn’t decide whether you qualify."}
              </p>
            </fieldset>
            {grouped.work.length > 0 && <CardList cards={grouped.work} idBase={`${uid}-work`} />}
          </div>

          {supports.length > 0 && (
            <div className={s.group}>
              <h3 className={s.groupTitle}>Support for you</h3>
              <CardList cards={shownSupports} idBase={`${uid}-support`} />
              {hiddenSupports > 0 && (
                <div className={s.more}>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setAllSupports(true);
                      window.requestAnimationFrame(() => document.getElementById(firstExtraId)?.focus());
                    }}
                  >
                    Show {hiddenSupports} more
                  </Button>
                </div>
              )}
            </div>
          )}

          {grouped.other.length > 0 && <CardGroup title="More help" cards={grouped.other} idBase={`${uid}-other`} />}

          {usesOsm && safeHref(guide.attribution.url) && (
            <p className={s.attribution}>
              Map data{" "}
              <a href={safeHref(guide.attribution.url) ?? undefined} target="_blank" rel="noopener noreferrer">
                {guide.attribution.text}
                <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
              </a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function CardGroup({ title, cards, idBase }: { title: string; cards: GuideCardView[]; idBase: string }) {
  return (
    <div className={s.group}>
      <h3 className={s.groupTitle}>{title}</h3>
      <CardList cards={cards} idBase={idBase} />
    </div>
  );
}

function CardList({ cards, idBase }: { cards: GuideCardView[]; idBase: string }) {
  return (
    <ul className={s.list} role="list">
      {cards.map((card, index) => (
        <HelpCard key={card.id} card={card} headingId={`${idBase}-${index}`} />
      ))}
    </ul>
  );
}

function HelpCard({ card, headingId }: { card: GuideCardView; headingId: string }) {
  const Icon = ICONS[card.kind] ?? MapPin;
  const links = card.links
    .map((link) => ({ label: link.label, href: safeHref(link.url) }))
    .filter((link): link is { label: string; href: string } => link.href !== null);
  const source = safeHref(card.sourceUrl);
  // the source name links only when no card link already points at the same page
  const sourceHref = source && !links.some((link) => link.href === source) ? source : null;
  const checked = checkedOn(card.fetchedAt);

  return (
    <li className={s.item}>
      <span className={s.icon} aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className={s.itemBody}>
        <h4 id={headingId} tabIndex={-1} className={s.itemTitle}>
          {card.title}
        </h4>
        <p className={s.itemText}>{card.body}</p>
        {card.details.length > 0 && (
          <dl className={s.details}>
            {card.details.map((detail, index) => (
              <div key={`${detail.label}-${index}`} className={s.detail}>
                <dt>{detail.label}</dt>
                <dd>
                  <DetailValue label={detail.label} value={detail.value} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {card.draftNotice && <EmployerNotice text={card.draftNotice} />}
        {links.length > 0 && (
          <ul className={s.links} role="list">
            {links.map((link) => (
              <li key={link.href}>
                <a className={s.link} href={link.href} target="_blank" rel="noopener noreferrer">
                  {link.label}
                  <ExternalLink size={15} aria-hidden="true" />
                  <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className={s.source}>
          Source:{" "}
          {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer">
              {card.source}
              <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
            </a>
          ) : (
            card.source
          )}
          {checked ? (
            <>
              , checked <span className={s.nowrap}>{checked}</span>.
            </>
          ) : (
            "."
          )}
          {card.license ? ` Licence: ${card.license}.` : ""}
        </p>
      </div>
    </li>
  );
}

/** phone numbers become tap-to-call links on phones; everything else stays plain text */
function DetailValue({ label, value }: { label: string; value: string }) {
  const digits = value.replace(/[^\d+]/g, "");
  if (label.toLowerCase() === "phone" && /^\+?\d{3,15}$/.test(digits)) {
    return (
      <a className={s.tel} href={`tel:${digits}`}>
        {value}
      </a>
    );
  }
  return <>{value}</>;
}

function EmployerNotice({ text }: { text: string }) {
  const announce = useAnnounce();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      announce("Copied the notice.");
    } catch {
      setStatus("failed");
      announce("Couldn’t copy. Select the text and copy it yourself.");
    }
  }

  return (
    <div className={s.notice}>
      <p className={s.noticeLabel}>A short notice for your employer. It shares no health details.</p>
      <p className={s.noticeText}>{text}</p>
      <div className={s.noticeActions}>
        <Button variant="secondary" onClick={() => void copy()}>
          <Copy size={17} aria-hidden="true" />
          {status === "copied" ? "Copied" : "Copy the notice"}
        </Button>
        {status === "failed" && <p className={s.hint}>Couldn’t copy. Select the text and copy it yourself.</p>}
      </div>
    </div>
  );
}

function groupCards(cards: GuideCardView[]): Record<GroupKey, GuideCardView[]> {
  const groups: Record<GroupKey, GuideCardView[]> = { near: [], work: [], support: [], other: [] };
  // the api's order is kept inside each group
  for (const card of cards) groups[GROUP_OF[card.kind] ?? "other"].push(card);
  return groups;
}

/** "DOWNTOWN EAST VILLAGE" reads as "Downtown East Village" */
function placeName(community: string): string {
  return community
    .toLowerCase()
    .replace(/(^|[\s/-])([a-z])/g, (_, gap: string, letter: string) => `${gap}${letter.toUpperCase()}`)
    .replace(/\b(Ne|Nw|Se|Sw)\b/g, (quadrant) => quadrant.toUpperCase());
}

/** "Nov 7, 2026" for the date part of a fetched-at value; null when there is none */
function checkedOn(value: string): string | null {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  if (!day) return null;
  const ms = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(ms);
}
