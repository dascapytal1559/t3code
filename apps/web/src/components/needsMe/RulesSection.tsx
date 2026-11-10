import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type PendingRule,
  type Rule,
  type RulesState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn, randomUUID } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BridgeSection } from "./BridgeSection";
import { groupRules, ruleCopyText } from "./rules.logic";

const TO_REVIEW_ONLY_KEY = "t3code:bridge:rules-to-review-only";

const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap";

/**
 * The user's rules for FirstMate, every one of them, under their headings. Approved rules carry a
 * solid chip; a pending one carries FirstMate's recommendation as a dashed chip, which agrees with
 * it in one click.
 */
export function RulesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly state: RulesState;
}) {
  const [toReviewOnly, setToReviewOnly] = useLocalStorage(
    TO_REVIEW_ONLY_KEY,
    false,
    Schema.Boolean,
  );
  const { rules, sent } = props.state;
  const pending = rules.filter((rule) => rule.status === "pending").length;
  const shown = toReviewOnly ? rules.filter((rule) => rule.status === "pending") : rules;
  const sentIds = new Set(sent);

  return (
    <BridgeSection
      id="rules"
      title="Rules"
      count={rules.length}
      {...(pending === 0 ? {} : { detail: `${pending} to review` })}
    >
      {pending === 0 ? null : (
        <div className="flex justify-end px-1 pb-1">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-pressed={toReviewOnly}
            onClick={() => setToReviewOnly(!toReviewOnly)}
          >
            {toReviewOnly ? <CheckIcon aria-hidden /> : null}
            To review only
          </Button>
        </div>
      )}
      {groupRules(shown).map(({ group, rules: members }) => (
        <section key={group} aria-label={group} className="mb-3">
          <h3 className="px-2 pb-1 text-xs font-semibold text-foreground">{group}</h3>
          <ul className="flex flex-col gap-1.5">
            {members.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                environmentId={props.environmentId}
                sent={sentIds.has(rule.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </BridgeSection>
  );
}

function RuleRow(props: {
  readonly rule: Rule;
  readonly environmentId: EnvironmentId;
  readonly sent: boolean;
}) {
  const { rule, environmentId } = props;
  const markdown = (text: string, className: string) => (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      environmentId={environmentId}
      className={cn("text-sm leading-relaxed [&_p]:my-0", className)}
    />
  );
  return (
    <li className="min-w-0 rounded-lg border border-border/70 px-3 py-2">
      {markdown(rule.text, "text-foreground/90")}
      {rule.status === "pending" && rule.recommendation.note !== undefined
        ? markdown(rule.recommendation.note, "mt-1 text-muted-foreground")
        : null}
      {rule.status === "pending" && rule.recommendation.proposedText !== undefined ? (
        <div className="mt-1 border-l-2 border-border ps-2">
          <span className="text-xs text-muted-foreground">Proposed</span>
          {markdown(rule.recommendation.proposedText, "text-foreground/80")}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {rule.id}
          {rule.source === undefined ? null : ` · ${rule.source}`}
        </span>
        {rule.status === "approved" ? (
          <span className={cn(CHIP, "border-transparent bg-success/12 text-success-foreground")}>
            <CheckIcon aria-hidden className="size-3" />
            Approved
            {rule.approvedOn === undefined ? null : (
              <span className="font-normal opacity-70">{rule.approvedOn}</span>
            )}
          </span>
        ) : (
          <RecommendationChip rule={rule} environmentId={environmentId} sent={props.sent} />
        )}
        <RuleCopyButton rule={rule} />
      </div>
    </li>
  );
}

function RecommendationChip(props: {
  readonly rule: PendingRule;
  readonly environmentId: EnvironmentId;
  readonly sent: boolean;
}) {
  const { rule, environmentId } = props;
  const [sending, setSending] = useState(false);
  const answer = useAtomCommand(orchestrationEnvironment.answerRule);
  const permitted = useAtomValue(orchestrationEnvironment.answerRule.permissionAtom(environmentId));
  const { label } = rule.recommendation;

  if (props.sent) {
    return (
      <span className={cn(CHIP, "border-primary bg-primary text-primary-foreground")}>
        <CheckIcon aria-hidden className="size-3" />
        {label}
        <span className="font-normal opacity-80">· Sent</span>
      </span>
    );
  }

  const agree = async () => {
    if (sending || !permitted) return;
    setSending(true);
    const result = await answer({
      environmentId,
      input: {
        ruleId: rule.id,
        recommendation: rule.recommendation,
        commandId: CommandId.make(`web:rule-answer:${randomUUID()}`),
      },
    });
    setSending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not send rule ${rule.id} to FirstMate`,
      description: error instanceof Error ? error.message : undefined,
    });
  };

  return (
    <button
      type="button"
      disabled={sending || !permitted}
      aria-label={`Agree with the recommendation on rule ${rule.id}: ${label}`}
      className={cn(
        CHIP,
        "cursor-pointer border-dashed border-primary/70 bg-transparent text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none disabled:cursor-default disabled:opacity-60",
      )}
      onClick={() => void agree()}
    >
      {label}
    </button>
  );
}

function RuleCopyButton(props: { readonly rule: Rule }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={ref}
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Copy rule ${props.rule.id}`}
            onClick={() => copyToClipboard(ruleCopyText(props.rule), undefined)}
          />
        }
      >
        {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{isCopied ? "Copied" : "Copy, to comment on it in chat"}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
