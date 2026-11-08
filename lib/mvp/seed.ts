// fictional demo persona for the local MVP (PRD section 10): Alex, their contact groups, and their mom Rosa
import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { p, type SqlRunner } from "../db.ts";
import type { DisclosureTier } from "../state.ts";
import { resetClock } from "../store/clock.ts";

export const DEMO_EMAIL = "alex@example.test";

export type DemoContactKey = "teammateJordan" | "teammateSam" | "instructor" | "manager" | "sibling" | "coordinator";

interface GroupSeed {
  name: string;
  tier: DisclosureTier;
  contacts: { key: DemoContactKey; name: string; email: string; relationship: string }[];
}

// every person and address here is fictional; the care recipient's address is a public building (PRD D3)
export const DEMO_GROUPS: readonly GroupSeed[] = [
  {
    name: "School",
    tier: "minimal",
    contacts: [
      { key: "teammateJordan", name: "Jordan Lee", email: "jordan.lee@example.test", relationship: "project teammate" },
      { key: "teammateSam", name: "Sam Patel", email: "sam.patel@example.test", relationship: "project teammate" },
      { key: "instructor", name: "Dr. Avery Brooks", email: "avery.brooks@example.test", relationship: "course instructor" },
    ],
  },
  {
    name: "Work",
    tier: "general",
    contacts: [{ key: "manager", name: "Morgan Chen", email: "morgan.chen@example.test", relationship: "manager" }],
  },
  {
    name: "Family",
    tier: "detailed",
    contacts: [{ key: "sibling", name: "Lucia Alvarez", email: "lucia.alvarez@example.test", relationship: "sibling" }],
  },
  {
    name: "Volunteer",
    tier: "minimal",
    contacts: [
      { key: "coordinator", name: "Priya Shah", email: "priya.shah@example.test", relationship: "volunteer coordinator" },
    ],
  },
];

// Calgary Central Library, a public building, used when data/calgary/persona.json is absent
const FALLBACK_ADDRESS = { address: "800 3 St SE, Calgary", lat: 51.0453, lng: -114.0546, community: null as string | null };

export interface DemoSeed {
  userId: string;
  careRecipientId: string;
  contacts: Record<DemoContactKey, string>;
}

function personaAddress(): typeof FALLBACK_ADDRESS {
  try {
    const file = path.join(process.cwd(), "data", "calgary", "persona.json");
    const persona = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const { address, lat, lng, community } = persona;
    // roughly the Calgary area, so a bad file cannot place Rosa elsewhere
    if (
      typeof address === "string" && address.trim() &&
      typeof lat === "number" && lat > 50.8 && lat < 51.3 &&
      typeof lng === "number" && lng > -114.4 && lng < -113.8
    ) {
      return { address: address.trim(), lat, lng, community: typeof community === "string" ? community : null };
    }
  } catch {
    // no persona file yet; the fallback address is used
  }
  return FALLBACK_ADDRESS;
}

/**
 * resets the demo persona: deleting the user cascades to every child row, then the user, contact groups, contacts
 * and care recipient are created again and the demo clock goes back to real time. intake creates the care episode.
 */
export async function seedDemo(sql: SqlRunner, now: Date): Promise<DemoSeed> {
  await sql.execute("DELETE FROM app_user WHERE email = :email", [p.text("email", DEMO_EMAIL)]);
  const users = await sql.query<{ id: string }>(
    "INSERT INTO app_user (email) VALUES (:email) RETURNING id::text AS id",
    [p.text("email", DEMO_EMAIL)],
  );
  const userId = users[0].id;

  const contacts = {} as Record<DemoContactKey, string>;
  for (const group of DEMO_GROUPS) {
    const groups = await sql.query<{ id: string }>(
      `INSERT INTO contact_group (user_id, name, disclosure_tier) VALUES (CAST(:user_id AS uuid), :name, :tier)
        RETURNING id::text AS id`,
      [p.uuid("user_id", userId), p.text("name", group.name), p.text("tier", group.tier)],
    );
    for (const contact of group.contacts) {
      const rows = await sql.query<{ id: string }>(
        `INSERT INTO contact (group_id, name, email, relationship) VALUES (CAST(:group_id AS uuid), :name, :email, :relationship)
          RETURNING id::text AS id`,
        [
          p.uuid("group_id", groups[0].id),
          p.text("name", contact.name),
          p.text("email", contact.email),
          p.text("relationship", contact.relationship),
        ],
      );
      contacts[contact.key] = rows[0].id;
    }
  }

  const home = personaAddress();
  const recipients = await sql.query<{ id: string }>(
    `INSERT INTO care_recipient (owner_id, alias, display_name, address, geog, community, is_fictional)
      VALUES (CAST(:user_id AS uuid), 'Mom', 'Rosa', :address,
        ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :community, true)
      RETURNING id::text AS id`,
    [
      p.uuid("user_id", userId),
      p.text("address", home.address),
      { name: "lng", value: { doubleValue: home.lng } },
      { name: "lat", value: { doubleValue: home.lat } },
      p.text("community", home.community),
    ],
  );

  await resetClock(sql);
  await sql.execute(
    `INSERT INTO audit_event (actor, action, entity, entity_id, detail)
      VALUES ('system', 'demo_seed', 'app_user', :user_id, jsonb_build_object('seeded_at', :seeded_at))`,
    [p.text("user_id", userId), p.text("seeded_at", now.toISOString())],
  );
  return { userId, careRecipientId: recipients[0].id, contacts };
}
