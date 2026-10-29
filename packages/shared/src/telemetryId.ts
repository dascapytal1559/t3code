import { sha256 } from "@noble/hashes/sha2";
import * as Hex from "effect/encoding/Hex";

/** Hashes an identifier before it reaches analytics. */
export const hashTelemetryId = (value: string): string =>
  Hex.encode(sha256(new TextEncoder().encode(value)));
