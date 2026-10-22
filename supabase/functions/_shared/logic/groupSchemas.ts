// Input shapes for the group callables.
//
// Kept beside the functions rather than in lib/schema.ts because they are used
// nowhere else, and because the fixed category list belongs next to the code
// that writes it.
import { z } from "zod";

export const docId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "must be a document id");

const name = z.string().trim().min(1).max(200);
/**
 * Nullable, not merely optional.
 *
 * The New group dialog sends every field it has, and an untouched
 * description arrives as null rather than absent. `z.string().optional()`
 * rejects that with "description: Expected string, received null", so a
 * group with no description could not be created at all: the most ordinary
 * path through the dialog was the one that did not work. Found 11 Sep 2026.
 */
const description = z.string().trim().max(2000).nullish()
  .transform((v) => v ?? "");

/**
 * The same field on an update, where absent and empty are different things.
 *
 * updateGroup writes only the keys it was given, so turning an absent
 * description into "" here would blank the description of every group
 * renamed from the info panel.
 */
const descriptionPatch = z.string().trim().max(2000).nullable().optional()
  .transform((v) => (v === null ? "" : v));

/**
 * The categories a group may have. A fixed list, not free text: the
 * dashboard filters on it, and a typo would make a group unfindable rather
 * than merely oddly labelled.
 */
export const CATEGORIES = [
  "aerospace", "automotive", "architecture", "consumer", "education",
  "energy", "industrial", "marine", "medical", "other",
] as const;

/** What a group gets when the dialog is left alone. Build spec 4.6. */
export const DEFAULT_CATEGORY = "education";

/*
 * Optional fields arrive as null, not as absent.
 *
 * The New group dialog posts every field it has, whether or not the person
 * filled it in, so an untouched tag list is `null` and an untouched category
 * is `null`. `.optional()` rejects those, one at a time, with messages like
 * "tags: Expected array, received null" - and the dialog stayed open with no
 * group created. Each of these is nullable for that reason; the transform
 * turns the null into the empty value the writer expects.
 */
const tags = z.array(z.string().trim().min(3).max(50)).max(12).nullish()
  .transform((v) => v ?? []);
const unitSystem = z.enum(["SI", "IMPERIAL"]).nullish().transform((v) => v ?? "SI");
const category = z.enum(CATEGORIES).nullish().transform((v) => v ?? DEFAULT_CATEGORY);

/*
 * The same three on an update, where absent must stay absent.
 *
 * updateGroup writes only the keys it was given. If these defaulted the way
 * the create versions do, renaming a group from the info panel would also
 * empty its tags and reset its category, because the rename call carries
 * neither.
 */
const tagsPatch = z.array(z.string().trim().min(3).max(50)).max(12).nullable().optional()
  .transform((v) => (v === null ? [] : v));
const unitSystemPatch = z.enum(["SI", "IMPERIAL"]).nullable().optional()
  .transform((v) => v ?? undefined);
const categoryPatch = z.enum(CATEGORIES).nullable().optional()
  .transform((v) => v ?? undefined);

export const createGroupSchema = z.object({
  name,
  description,
  category,
  tags,
  unit_system: unitSystem,
});

export const updateGroupSchema = z.object({
  group_id: docId,
  name: name.optional(),
  description: descriptionPatch,
  category: categoryPatch,
  tags: tagsPatch,
  unit_system: unitSystemPatch,
});

export const groupIdSchema = z.object({ group_id: docId });

export const copyGroupSchema = z.object({
  group_id: docId,
  name: name.optional(),
});

export const shareGroupSchema = z.object({
  group_id: docId,
  email: z.string().trim().email("That is not an email address.").max(320),
  permission: z.enum(["view", "copy", "edit"]),
});

export const unshareGroupSchema = z.object({
  group_id: docId,
  uid: docId,
});

