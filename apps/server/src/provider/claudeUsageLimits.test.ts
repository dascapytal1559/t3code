import { describe, expect, it } from "vite-plus/test";

import {
  claudeOauthUsageRateLimits,
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });

  const enterpriseResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        percent: 9,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 4_631,
        monthly_limit: 50_000,
        utilization: 9.261999999999999,
        currency: "USD",
        decimal_places: 2,
      },
    },
  };
  const monthlyWindow = {
    id: "monthly_spend",
    kind: "monthly",
    label: "Monthly spend",
    usedPercent: expect.closeTo(9.262, 10),
  };

  it("maps the captured Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(claudeUsageResponseToLimits({ checkedAt, response: enterpriseResponse }).limits).toEqual(
      {
        checkedAt,
        windows: [monthlyWindow],
      },
    );
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        five_hour: { utilization: 12, resets_at: null },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: 30_000,
          utilization: 60,
        },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      monthlyWindow,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        spend: {
          ...enterpriseResponse.rate_limits.spend,
          enabled: false,
          used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
        },
        extra_usage: { ...enterpriseResponse.rate_limits.extra_usage, utilization: 9 },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      monthlyWindow,
    ]);
    const utilizationOnly = {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        spend: { enabled: true, used: null, limit: null, percent: 9 },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: null,
          monthly_limit: null,
        },
      },
    };
    expect(
      claudeUsageResponseToLimits({ checkedAt, response: utilizationOnly }).limits.windows,
    ).toEqual([monthlyWindow]);
  });

  it("flags a $0 cap instead of reporting a monthly window", () => {
    const response = {
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: null,
        extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 0, utilization: null },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits).toEqual({
      checkedAt,
      windows: [],
      zeroSpendCap: true,
    });
  });

  it("omits disabled budgets and refuses invalid money without an enabled fallback", () => {
    const rateLimits = enterpriseResponse.rate_limits;
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...rateLimits,
        spend: { ...rateLimits.spend, enabled: false },
        extra_usage: { ...rateLimits.extra_usage, is_enabled: false },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, currency: "EUR" },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, amount_minor: 0 },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });
});

// Recorded from /api/oauth/usage?cedar_ember=1&skip_spend=1 (16 Nov 2026); unrelated null keys trimmed.
const RECORDED_OAUTH_USAGE = {
  five_hour: {
    utilization: 100.0,
    resets_at: "2026-11-16T03:40:00.108730+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 74.0,
    resets_at: "2026-11-16T03:59:59.108754+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  cedar_ember: {
    eligible: false,
    ineligible_reason: "surface",
    at_limit: false,
    exhausted: [],
    grants: [],
    next_grant_id: null,
    weekly_resets_at: null,
    cooldown_until: null,
    event_props: null,
  },
  extra_usage: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 100,
      severity: "critical",
      resets_at: "2026-11-16T03:40:00.108730+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 74,
      severity: "normal",
      resets_at: "2026-11-16T03:59:59.108754+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 96,
      severity: "critical",
      resets_at: "2026-11-16T04:00:00.108918+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  spend: null,
  seven_day_breakdown: {
    as_of: "2026-11-16T02:59:34.129883+00:00",
    window_started_at: "2026-11-09T03:59:59.108754+00:00",
    rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }],
  },
  weekly_scoped_shares: [
    { limit_index: 2, used_percent_of_weekly: 48, allowance_percent_of_weekly: 50 },
  ],
};

describe("claudeOauthUsageRateLimits", () => {
  it("reads the CLI's get_usage windows from a recorded usage body", () => {
    const rateLimits = claudeOauthUsageRateLimits(RECORDED_OAUTH_USAGE);
    expect(rateLimits).toEqual({
      five_hour: { utilization: 100, resets_at: "2026-11-16T03:40:00.108730+00:00" },
      seven_day: { utilization: 74, resets_at: "2026-11-16T03:59:59.108754+00:00" },
      model_scoped: [
        { display_name: "Fable", utilization: 96, resets_at: "2026-11-16T04:00:00.108918+00:00" },
      ],
    });
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: true, rate_limits: rateLimits! },
      }).limits.windows.map((window) => [window.id, window.usedPercent]),
    ).toEqual([
      ["five_hour", 100],
      ["seven_day", 74],
      ["seven_day_fable", 96],
    ]);
    // A body without windows, or with a window in an unknown shape, leaves the probe's reading.
    expect(claudeOauthUsageRateLimits({ cedar_ember: RECORDED_OAUTH_USAGE.cedar_ember })).toBe(
      undefined,
    );
    expect(
      claudeOauthUsageRateLimits({ ...RECORDED_OAUTH_USAGE, five_hour: { utilization: "100" } }),
    ).toBe(undefined);
  });
});
