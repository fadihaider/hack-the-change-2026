import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Check,
  HandCoins,
  HeartHandshake,
  ShieldCheck,
} from "lucide-react";

const resources = [
  {
    title: "Time away from work",
    description: "Explore leave information",
    href: "https://www.alberta.ca/personal-family-responsibility-leave",
    icon: BriefcaseBusiness,
  },
  {
    title: "Caregiver support",
    description: "Find support for you",
    href: "https://www.albertahealthservices.ca/services/Page13155.aspx",
    icon: HeartHandshake,
  },
  {
    title: "Caregiving benefits",
    description: "Explore financial support",
    href: "https://www.canada.ca/en/services/benefits/ei/caregiving.html",
    icon: HandCoins,
  },
] as const;

export default function SupportSidebar({
  onOpenGuide,
}: {
  onOpenGuide: () => void;
}) {
  return (
    <section className="support-sidebar" aria-label="First 72 hours support">
      <div className="support-heading">
        <h2>Your first 72 hours</h2>
        <p>A few places to find your footing.</p>
      </div>
      <div className="support-card">
        {resources.map(({ title, description, href, icon: Icon }) => (
          <a
            className="support-resource"
            href={href}
            key={title}
            target="_blank"
            rel="noreferrer"
            aria-label={`${title} (opens in a new tab)`}
          >
            <span className="support-icon" aria-hidden="true">
              <Icon size={21} strokeWidth={1.7} />
            </span>
            <span className="support-copy">
              <strong>{title}</strong>
              <span>{description}</span>
            </span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        ))}
        <p className="support-footnote">
          Official resources · check eligibility and availability
        </p>
        <button className="secondary full" onClick={onOpenGuide}>
          Open the support guide <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="assurance-card">
        <ShieldCheck size={22} strokeWidth={1.7} aria-hidden="true" />
        <h3>You stay in control.</h3>
        <ul>
          <li>
            <Check size={15} aria-hidden="true" /> You review every message.
          </li>
          <li>
            <Check size={15} aria-hidden="true" /> Your calendar stays
            untouched.
          </li>
          <li>
            <Check size={15} aria-hidden="true" /> You choose what to share.
          </li>
        </ul>
      </div>
    </section>
  );
}
