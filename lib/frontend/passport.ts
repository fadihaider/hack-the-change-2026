// care passport sections (PRD 5.1): how stored fact categories group into the seven sections the caregiver sees.
// pure data, shared by the care page and tests. "practical" is the category for belongings and household know-how.

export type PassportSectionId =
  | "routine"
  | "communication"
  | "preferences"
  | "practical"
  | "contacts"
  | "instructions"
  | "open";

export interface PassportSection {
  id: PassportSectionId;
  title: string;
  /** one line under the title when expanded */
  hint: string;
  /** stored care_fact categories shown here when approved; "open" collects open questions, conflicts and pending items */
  categories: readonly string[];
}

export const PASSPORT_SECTIONS: readonly PassportSection[] = [
  { id: "routine", title: "Daily routine", hint: "Wake, meals, activities and bedtime, as you described them.", categories: ["routine"] },
  {
    id: "communication",
    title: "Communication & accessibility",
    hint: "Hearing, language, how to explain things, and mobility needs you provided.",
    categories: ["communication", "mobility"],
  },
  { id: "preferences", title: "Preferences & interests", hint: "Likes, dislikes, comfort and company.", categories: ["preference"] },
  {
    id: "practical",
    title: "Practical needs & belongings",
    hint: "Where things are and how the household works.",
    categories: ["practical"],
  },
  {
    id: "contacts",
    title: "Contacts & logistics",
    hint: "People to call, appointments, pickups and who is allowed to help.",
    categories: ["contacts", "logistics"],
  },
  {
    id: "instructions",
    title: "Written care instructions",
    hint: "Exact wording from documents you added. ReliefReady never rewrites or interprets these.",
    categories: ["medical_instruction"],
  },
  {
    id: "open",
    title: "Open questions & conflicts",
    hint: "Questions nobody has answered yet, notes that disagree, and things still waiting for your check.",
    categories: [],
  },
] as const;

/** the section an approved fact of this category belongs to; unknown categories fall back to practical */
export function sectionOf(category: string): PassportSectionId {
  for (const section of PASSPORT_SECTIONS) {
    if (section.categories.includes(category)) return section.id;
  }
  return "practical";
}
