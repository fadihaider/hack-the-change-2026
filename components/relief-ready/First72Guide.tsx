"use client";

import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Heart,
  MapPin,
  ShieldCheck,
  Sprout,
  Users,
} from "lucide-react";

const checked = "2026-11-07";
const leaveUrl = "https://www.alberta.ca/personal-family-responsibility-leave";

export default function First72Guide({
  onPrepareNotice,
}: {
  onPrepareNotice: () => void;
}) {
  const [tenure, setTenure] = useState<"yes" | "no" | "unsure" | null>(null);
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
            Start with these sourced supports. Nearby resources still need a
            verified Calgary address.
          </p>
        </div>
      </div>
      <section className="panel tenure-panel" aria-labelledby="tenure-title">
        <span className="section-kicker">
          A LITTLE CONTEXT FOR WORK SUPPORT
        </span>
        <h2 id="tenure-title">
          Have you worked for this employer for 90 days or more?
        </h2>
        <div
          className="tenure-choices"
          role="group"
          aria-labelledby="tenure-title"
        >
          {(
            [
              ["yes", "Yes"],
              ["no", "No"],
              ["unsure", "Not sure"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={tenure === value ? "primary" : "secondary"}
              aria-pressed={tenure === value}
              onClick={() => setTenure(value)}
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
            The 90-day threshold has not been met, so the statutory leave card
            is hidden. Your employer may still agree to time away.{" "}
            <a href={leaveUrl} target="_blank" rel="noreferrer">
              Read Alberta’s requirements
            </a>
            .
          </p>
        )}
      </section>
      <div className="guide-grid">
        {(tenure === "yes" || tenure === "unsure") && (
          <article
            className="panel guide-card"
            aria-labelledby="leave-card-title"
          >
            <div className="guide-number">
              <Users />
              <span>01</span>
            </div>
            <h2 id="leave-card-title">Make space at work</h2>
            <p>
              Alberta’s personal and family responsibility leave provides
              eligible employees up to 5 days per calendar year after 90 days
              with the same employer. Leave is unpaid unless an employment
              contract or collective agreement provides otherwise.
            </p>
            {tenure === "unsure" && (
              <p className="small-note">
                Check your start date and employment coverage before relying on
                this leave.
              </p>
            )}
            <button className="secondary" onClick={onPrepareNotice}>
              Prepare an employer notice <ArrowRight size={15} />
            </button>
            <a
              className="card-source"
              href={leaveUrl}
              target="_blank"
              rel="noreferrer"
            >
              Government of Alberta <ArrowRight size={15} />
            </a>
            <span className="small-note">
              Source checked {checked} · Confirm current requirements
            </span>
          </article>
        )}
        <article className="panel guide-card">
          <div className="guide-number">
            <ShieldCheck />
            <span>02</span>
          </div>
          <h2>Explore financial support</h2>
          <p>
            EI caregiving benefits may apply when a medical doctor or nurse
            practitioner certifies that the person is critically ill or injured,
            or needs end-of-life care. Other eligibility requirements also
            apply.
          </p>
          <a
            href="https://www.canada.ca/en/services/benefits/ei/caregiving.html"
            target="_blank"
            rel="noreferrer"
          >
            Government of Canada <ArrowRight size={15} />
          </a>
          <span className="small-note">
            Source checked {checked} · Not an eligibility determination
          </span>
        </article>
        <article className="panel guide-card">
          <div className="guide-number">
            <Heart />
            <span>03</span>
          </div>
          <h2>Find caregiver support</h2>
          <p>
            The AHS Family Caregiver Centre offers information, education and
            support for unpaid family caregivers in the Calgary Zone. Check the
            service listing for contact details and access.
          </p>
          <a
            href="https://www.albertahealthservices.ca/services/Page13155.aspx"
            target="_blank"
            rel="noreferrer"
          >
            AHS Family Caregiver Centre <ArrowRight size={15} />
          </a>
          <span className="small-note">
            Source checked {checked} · Confirm availability with AHS
          </span>
        </article>
        <article className="panel guide-card">
          <div className="guide-number">
            <MapPin />
            <span>04</span>
          </div>
          <h2>Connect with your community</h2>
          <p>
            Explore community supports through InformAlberta. Location, hours,
            accessibility and provider availability have not been verified in
            this demo.
          </p>
          <a href="https://informalberta.ca/" target="_blank" rel="noreferrer">
            InformAlberta directory <ArrowRight size={15} />
          </a>
          <span className="small-note">
            Directory link · individual listings not yet retrieved
          </span>
        </article>
      </div>
      <div className="panel local-card">
        <MapPin size={24} />
        <div>
          <h3>Nearby help, when the location is verified.</h3>
          <p>
            Hospital, pharmacy and transit cards will appear after Calgary
            address lookup is connected. Hours and accessibility are currently
            unknown.
          </p>
        </div>
        <span className="badge">Location service pending</span>
      </div>
      <p className="small-note">
        Map data, when connected: ©{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          OpenStreetMap contributors
        </a>
        .
      </p>
    </>
  );
}
