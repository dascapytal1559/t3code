import type { EnvironmentId, Rule } from "@t3tools/contracts";

/** Rules under their headings, headings in the order they first appear. */
export function groupRules(rules: ReadonlyArray<Rule>): ReadonlyArray<{
  readonly group: string;
  readonly rules: ReadonlyArray<Rule>;
}> {
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) {
    const members = groups.get(rule.group);
    if (members === undefined) groups.set(rule.group, [rule]);
    else members.push(rule);
  }
  return Array.from(groups, ([group, members]) => ({ group, rules: members }));
}

/** What the copy button puts on the clipboard, for the user to paste into chat with a comment. */
export function ruleCopyText(rule: Rule): string {
  const lines = [`Rule ${rule.id} (${rule.group}): ${rule.text}`];
  if (rule.status === "pending") {
    const { label, note, proposedText } = rule.recommendation;
    // oxlint-disable-next-line t3code/no-em-dash-copy -- FirstMate's copy format names the dash
    lines.push(`Your recommendation: ${label}${note === undefined ? "" : ` — ${note}`}`);
    if (proposedText !== undefined) lines.push(`Proposed wording: ${proposedText}`);
  }
  return lines.join("\n");
}

/** The host chat's environment's rules, else the first connected environment's that has some. */
export function pickBridgeRules<T extends { readonly environmentId: EnvironmentId }>(
  lists: ReadonlyArray<T>,
  hostEnvironmentId: EnvironmentId,
): T | null {
  return lists.find((list) => list.environmentId === hostEnvironmentId) ?? lists[0] ?? null;
}
