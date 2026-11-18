// Fork: thumb Back/Forward (buttons 3 and 4) do nothing in the app. Chromium focuses on an
// uncancelled mousedown and steps the app router's history on an uncancelled mouseup.
const cancelThumbButton = (event: Event) => {
  const { button } = event as MouseEvent;
  if (button === 3 || button === 4) event.preventDefault();
};

export function installThumbButtonGuard(target: EventTarget) {
  target.addEventListener("mousedown", cancelThumbButton, true);
  target.addEventListener("mouseup", cancelThumbButton, true);
}
