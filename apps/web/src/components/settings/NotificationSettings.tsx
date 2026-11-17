import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  NOTIFICATION_SOUND_SCOPE_LABELS,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const soundScope = useScopedSettings((settings) => settings.notificationSoundScope);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open."
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage(
                    "Notifications are unavailable in this browser. Sound only is still available.",
                  );
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {hasNotificationSound(mode) ? (
        <SettingsRow
          {...searchableSetting("notification-sound-scope")}
          description="Which threads play the sound. Other threads still notify, silently."
          control={
            <Select
              value={soundScope}
              onValueChange={(value) => {
                if (value !== "all-threads" && value !== "firstmate") return;
                updateSettings({ notificationSoundScope: value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Sound for">
                <SelectValue>{NOTIFICATION_SOUND_SCOPE_LABELS[soundScope]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(NOTIFICATION_SOUND_SCOPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} hideIndicator value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}
