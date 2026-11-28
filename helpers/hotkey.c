// Global shortcut helper. Native SDK has no global shortcut, so this process
// registers Control+Option+Space through Carbon and prints HOTKEY on each press.
// RegisterEventHotKey needs no Accessibility permission.
#include <Carbon/Carbon.h>
#include <stdio.h>
#include <unistd.h>

// Still exported on arm64, but the 64-bit headers hide the declaration.
extern void RunApplicationEventLoop(void);

static OSStatus on_hotkey(EventHandlerCallRef next, EventRef event, void *data) {
  puts("HOTKEY");
  fflush(stdout);
  return noErr;
}

static void exit_with_parent(CFRunLoopTimerRef timer, void *parent) {
  if (getppid() != (pid_t)(intptr_t)parent) exit(0);
}

int main(void) {
  EventTypeSpec pressed = {kEventClassKeyboard, kEventHotKeyPressed};
  InstallApplicationEventHandler(&on_hotkey, 1, &pressed, NULL, NULL);

  EventHotKeyID id = {'ncst', 1};
  EventHotKeyRef ref;
  OSStatus status = RegisterEventHotKey(kVK_Space, controlKey | optionKey, id, GetApplicationEventTarget(), 0, &ref);
  if (status != noErr) {
    fprintf(stderr, "RegisterEventHotKey failed: %d\n", (int)status);
    return 1;
  }

  CFRunLoopTimerContext context = {0, (void *)(intptr_t)getppid(), NULL, NULL, NULL};
  CFRunLoopAddTimer(CFRunLoopGetCurrent(),
                    CFRunLoopTimerCreate(NULL, 0, 1, 0, 0, exit_with_parent, &context),
                    kCFRunLoopCommonModes);

  puts("READY");
  fflush(stdout);
  RunApplicationEventLoop();
  return 0;
}
