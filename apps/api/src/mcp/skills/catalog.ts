import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDirectory = dirname(fileURLToPath(import.meta.url));

export const skillUri = "skill://money-maker/money-maker-operator/SKILL.md";
export const setupSkillUri = "skill://money-maker/money-maker-setup/SKILL.md";
export const pendingSkillUri = "skill://money-maker/money-maker-pending/SKILL.md";
export const nicheSkillUri = "skill://money-maker/money-maker-niche/SKILL.md";
export const packageSkillUri = "skill://money-maker/money-maker-package/SKILL.md";
export const explainerSkillUri = "skill://money-maker/money-maker-explainer/SKILL.md";

const skillPathByUri: Readonly<Record<string, string>> = {
  [skillUri]: join(skillsDirectory, "money-maker-operator", "SKILL.md"),
  [setupSkillUri]: join(skillsDirectory, "money-maker-setup", "SKILL.md"),
  [pendingSkillUri]: join(skillsDirectory, "money-maker-pending", "SKILL.md"),
  [nicheSkillUri]: join(skillsDirectory, "money-maker-niche", "SKILL.md"),
  [packageSkillUri]: join(skillsDirectory, "money-maker-package", "SKILL.md"),
  [explainerSkillUri]: join(skillsDirectory, "money-maker-explainer", "SKILL.md"),
};

export const readSkill = async (uri = skillUri) => {
  const path = skillPathByUri[uri];
  if (!path) throw new Error("skill_not_found");
  const text = await readFile(path, "utf8");
  return { uri, digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, text };
};

export const listSkills = async () => {
  const skills = await Promise.all(
    Object.keys(skillPathByUri).map(async (uri) => {
      const skill = await readSkill(uri);
      const id = uri.split("/").at(-2) ?? uri;
      return {
        id,
        uri,
        version: /^version:\s*(\S+)/m.exec(skill.text)?.[1] ?? "unknown",
        resources: [{ uri, digest: skill.digest }],
      };
    }),
  );
  return { skills };
};
