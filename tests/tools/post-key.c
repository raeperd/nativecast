// Posts one key chord as a real OS event: post-key <keycode> [ctrl] [opt] [cmd] [shift].
// The global shortcut cannot be reached through `native automate`.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  CGKeyCode key = (CGKeyCode)atoi(argv[1]);
  CGEventFlags flags = 0;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "ctrl")) flags |= kCGEventFlagMaskControl;
    if (!strcmp(argv[i], "opt")) flags |= kCGEventFlagMaskAlternate;
    if (!strcmp(argv[i], "cmd")) flags |= kCGEventFlagMaskCommand;
    if (!strcmp(argv[i], "shift")) flags |= kCGEventFlagMaskShift;
  }
  fprintf(stderr, "accessibility trusted: %d\n", AXIsProcessTrusted());
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  for (int down = 1; down >= 0; down--) {
    CGEventRef event = CGEventCreateKeyboardEvent(source, key, down);
    CGEventSetFlags(event, flags);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
  }
  return 0;
}
