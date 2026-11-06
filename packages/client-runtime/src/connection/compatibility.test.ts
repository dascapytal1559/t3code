import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ClientSurface,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";

const descriptor = (orchestrationProtocolVersion?: number): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Build Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "9.0.0",
  ...(orchestrationProtocolVersion === undefined ? {} : { orchestrationProtocolVersion }),
  capabilities: { repositoryIdentity: true },
});

describe("orchestration protocol compatibility", () => {
  it("accepts the current protocol and announces it without disturbing socket credentials", () => {
    expect(
      orchestrationProtocolCompatibilityError(descriptor(ORCHESTRATION_PROTOCOL_VERSION)),
    ).toBeNull();

    const socketUrl = (surface: ClientSurface | undefined) =>
      new URL(
        appendOrchestrationProtocol(
          "wss://host.test/ws?wsTicket=secret&connectionMethod=relay",
          surface,
        ),
      );
    const mobile = socketUrl("mobile");
    expect(mobile.searchParams.get("orchestrationProtocol")).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(mobile.searchParams.get("clientCapabilities")).toBe("settingsSecretReferences");
    expect(mobile.searchParams.get("wsTicket")).toBe("secret");
    expect(mobile.searchParams.get("connectionMethod")).toBe("relay");
    // Fork: only clients with Needs me receive decision threads.
    for (const surface of ["web", "desktop"] as const) {
      expect(socketUrl(surface).searchParams.get("clientCapabilities")).toBe(
        "settingsSecretReferences,decisionThreads",
      );
    }
    expect(socketUrl(undefined).searchParams.get("clientCapabilities")).toBe(
      "settingsSecretReferences",
    );
  });

  it("treats missing metadata as protocol 1", () => {
    const error = orchestrationProtocolCompatibilityError(descriptor());
    if (Number(ORCHESTRATION_PROTOCOL_VERSION) === 1) {
      expect(error).toBeNull();
    } else {
      expect(error).toMatchObject({ reason: "unsupported" });
    }
  });

  it("blocks a different protocol before connecting", () => {
    const error = orchestrationProtocolCompatibilityError(
      descriptor(ORCHESTRATION_PROTOCOL_VERSION + 1),
    );
    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toContain("This client is not supported");
    expect(error).not.toHaveProperty("serverUpdateRequired");
  });

  it("offers a remote update only for an older host that can update itself", () => {
    const older = descriptor(ORCHESTRATION_PROTOCOL_VERSION - 1);
    const withCapabilities = (capabilities: ExecutionEnvironmentDescriptor["capabilities"]) =>
      orchestrationProtocolCompatibilityError({ ...older, capabilities });

    expect(
      withCapabilities({ repositoryIdentity: true, serverSelfUpdate: "boot-service" }),
    ).toMatchObject({ serverUpdateRequired: true });
    expect(withCapabilities({ repositoryIdentity: true })).not.toHaveProperty(
      "serverUpdateRequired",
    );
    expect(
      withCapabilities({ repositoryIdentity: true, serverSelfUpdate: "desktop-managed" }),
    ).not.toHaveProperty("serverUpdateRequired");
    expect(
      withCapabilities({
        repositoryIdentity: true,
        serverSelfUpdate: "desktop-managed",
        desktopAppUpdate: true,
      }),
    ).toMatchObject({ serverUpdateRequired: true });
  });
});
