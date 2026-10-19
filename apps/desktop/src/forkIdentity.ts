/**
 * Every value differs from upstream's so the fork never shares a bundle id, Electron
 * profile, data folder, or default port with an official T3 Code, and neither migrates
 * the other's database. The product name is `productName` in package.json.
 */
export const FORK_DESKTOP_IDENTITY = {
  appId: "com.t3tools.t3code.fork",
  stageLabel: "Fork",
  electronProfileDirName: "t3code-fork",
  baseDirName: ".t3-fork",
  backendPort: 3873,
} as const;
