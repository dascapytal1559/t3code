import type { MenuAction } from "@react-native-menu/menu";

/**
 * "Fork thread" row menu item (FORK_FEATURES.md: Fork a thread). Absent when
 * the server or the thread's provider cannot fork; disabled until the thread
 * has a settled turn to fork through.
 */
export function buildThreadForkMenuItems(input: {
  readonly supported: boolean;
  readonly canFork: boolean;
}): MenuAction[] {
  if (!input.supported) return [];

  return [
    {
      id: "fork",
      title: "Fork thread",
      image: "arrow.triangle.branch",
      ...(input.canFork ? {} : { attributes: { disabled: true } }),
    },
  ];
}
