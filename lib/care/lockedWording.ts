// written care instructions stay word for word (PRD 15): a fact is locked when it is a medical_instruction, or when
// its wording mentions medication, doses or wound care whatever category the extractor gave it. locked facts are never
// edited, shortened or paraphrased; they can only be replaced by a new source. pure, shared by server and client.

const TREATMENT_WORDS =
  /\b(?:medications?|medicines?|meds|pills?|tablets?|capsules?|doses?|dosage|mg|mcg|milligrams?|ml|insulin|inhalers?|prescriptions?|prescribed|antibiotics?|painkillers?|pain relievers?|tylenol|acetaminophen|ibuprofen|advil|aspirin|warfarin|blood thinners?|injections?|inject|incisions?|wounds?|dressings?|bandages?|stitches|sutures|eye drops|ear drops)\b/i;

/** true when this fact's exact wording must never be edited or shortened */
export function isLockedWording(category: string | null | undefined, text: string): boolean {
  return category === "medical_instruction" || TREATMENT_WORDS.test(text);
}
