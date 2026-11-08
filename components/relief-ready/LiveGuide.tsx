"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Bus,
  Copy,
  Heart,
  Hospital,
  MapPin,
  Pill,
  ShieldCheck,
  Sprout,
  Users,
} from "lucide-react";
import {
  createLiveApi,
  liveErrorMessage,
  safeHref,
  type GuideCardView,
  type GuideView,
  type LiveSession,
  type Tenure,
} from "@/lib/frontend/live-api.ts";

const api = createLiveApi();
const leaveUrl = "https://www.alberta.ca/personal-family-responsibility-leave";

const KIND_ICONS: Record<string, typeof Users> = {
  leave: Users,
  ei: ShieldCheck,
  support: Heart,
  hospital: Hospital,
  pharmacy: Pill,
  transit: Bus,
};

/** a link only when it is http or https; otherwise the label stays plain text */
function SafeLink({ url, children }: { url: string; children: ReactNode }) {
  const href = safeHref(url);
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} <ArrowRight size={15} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function GuideCard({ card, index }: { card: GuideCardView; index: number }) {
  const Icon = KIND_ICONS[card.kind] ?? MapPin;
  const [copied, setCopied] = useState(false);
  return (
    <article className="panel guide-card" aria-labelledby={`guide-${card.id}`}>
      <div className="guide-number">
        <Icon />
        <span>{String(index + 1).padStart(2, "0")}</span>
      </div>
      <h2 id={`guide-${card.id}`}>{card.title}</h2>
      <p className="plain-text">{card.body}</p>
      {card.details.length > 0 && (
        <dl className="fact-pairs">
          {card.details.map((d, i) => (
            <div key={`${d.label}-${i}`}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.draftNotice && (
        <div className="message-preview">
          <span className="message-label">
            Draft notice to your employer (minimal disclosure)
          </span>
          <p className="plain-text">{card.draftNotice}</p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(card.draftNotice ?? "")
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            <Copy size={14} /> {copied ? "Copied" : "Copy notice"}
          </button>
        </div>
      )}
      {card.links.length > 0 && (
        <div className="card-links">
          {card.links.map((link) => (
            <SafeLink key={link.url} url={link.url}>
              {link.label}
            </SafeLink>
          ))}
        </div>
      )}
      <span className="small-note">
        Source:{" "}
        <SafeLink url={card.sourceUrl}>{card.source}</SafeLink> · fetched{" "}
        {card.fetchedAt.slice(0, 10)}
        {card.license ? ` · ${card.license}` : ""}
      </span>
    </article>
  );
}

export default function LiveGuide({ session }: { session: LiveSession }) {
  const [tenure, setTenure] = useState<Tenure | null>(null);
  const [address, setAddress] = useState(session.careRecipient?.address ?? "");
  const [guide, setGuide] = useState<GuideView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(nextTenure: Tenure | null = tenure) {
    setLoading(true);
    setError("");
    try {
      setGuide(await api.guide(address, nextTenure ?? "not_sure"));
    } catch (e) {
      setGuide(null);
      setError(liveErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>You have a place to start.</h1>
          <p>The first 72 hours don’t have to come with all the answers.</p>
        </div>
        <span className="chapter">
          <BookOpen size={17} /> YOUR CALGARY GUIDE
        </span>
      </div>
      <div className="guide-intro">
        <Sprout size={36} strokeWidth={1.4} />
        <div>
          <h2>One small next step is enough.</h2>
          <p>
            Every card shows where it came from and when the data was fetched.
            Nearby help is found from the address below.
          </p>
        </div>
      </div>
      <section className="panel tenure-panel" aria-labelledby="live-tenure-title">
        <span className="section-kicker">A LITTLE CONTEXT FOR WORK SUPPORT</span>
        <h2 id="live-tenure-title">
          Have you worked for this employer for 90 days or more?
        </h2>
        <div className="tenure-choices" role="group" aria-labelledby="live-tenure-title">
          {(
            [
              ["yes", "Yes"],
              ["no", "No"],
              ["not_sure", "Not sure"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={tenure === value ? "primary" : "secondary"}
              aria-pressed={tenure === value}
              disabled={loading}
              onClick={() => {
                setTenure(value);
                void load(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="small-note">
          Your answer filters the leave card. It does not determine legal
          eligibility.
        </p>
        {tenure === "no" && (
          <p className="tenure-note" role="status">
            The 90-day threshold has not been met, so the statutory leave card is
            hidden. Your employer may still agree to time away.{" "}
            <a href={leaveUrl} target="_blank" rel="noreferrer">
              Read Alberta’s requirements
            </a>
            .
          </p>
        )}
        <form
          className="ask-form guide-address"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label htmlFor="live-address">
            Calgary address (the fictional persona uses a public building)
          </label>
          <input
            id="live-address"
            value={address}
            maxLength={200}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="800 3 St SE, Calgary"
          />
          <button className="primary" type="submit" disabled={loading}>
            {loading ? "Finding supports…" : "Find supports nearby"}{" "}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {guide && (
        <>
          <p className="small-note" role="status">
            <MapPin size={13} /> Showing {guide.cards.length} cards near{" "}
            {guide.location.address ?? "the care recipient’s address"}
            {guide.location.community ? ` · ${guide.location.community}` : ""}
          </p>
          <div className="guide-grid">
            {guide.cards.map((card, i) => (
              <GuideCard card={card} index={i} key={card.id} />
            ))}
          </div>
          <p className="small-note">
            Map data:{" "}
            {safeHref(guide.attribution.url) ? (
              <a
                href={safeHref(guide.attribution.url) ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                {guide.attribution.text}
              </a>
            ) : (
              guide.attribution.text
            )}
            . Hours and accessibility can change; confirm before you go.
          </p>
        </>
      )}
      {!guide && !error && (
        <div className="panel local-card">
          <MapPin size={24} />
          <div>
            <h3>Choose an answer above to see your guide.</h3>
            <p>
              Leave, benefits and caregiver supports, plus the nearest hospital,
              a pharmacy open now and nearby transit stops.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
