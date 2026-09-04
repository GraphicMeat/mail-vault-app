// Sets MailVault as the system's `mailto:` handler — the one thing the app
// itself cannot do.
//
// LSSetDefaultHandlerForURLScheme is refused inside the App Sandbox (OSStatus
// -54, and lsd logs "Unentitled request to set default handler for URL
// scheme"); MailVault's Developer ID build is sandboxed. This helper is not,
// so LaunchServices accepts the write from here. The app launches it through
// NSWorkspace with no arguments — a sandboxed caller's launch arguments are
// dropped by LaunchServices — hence one fixed job and no argv.
//
// The call itself is Thunderbird's (comm-central
// mail/components/shell/nsMacShellService.cpp), deprecation and all: Apple
// ships no replacement a non-privileged process can use.

#import <AppKit/AppKit.h>

// Both calls carry an availability attribute from the SDK headers AppKit pulls
// in; re-declaring them does not drop it.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

extern OSStatus LSSetDefaultHandlerForURLScheme(CFStringRef inURLScheme, CFStringRef inHandlerBundleID);
extern CFStringRef LSCopyDefaultHandlerForURLScheme(CFStringRef inURLScheme);

int main(void) {
  @autoreleasepool {
    // <MailVault.app>/Contents/Helpers/<this>.app → up three to MailVault.app.
    NSURL *outer = NSBundle.mainBundle.bundleURL.URLByDeletingLastPathComponent
                       .URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
    NSString *bundleId = [NSBundle bundleWithURL:outer].bundleIdentifier ?: @"com.mailvault.app";
    NSLog(@"MailVault default mail helper: claiming mailto: for %@", bundleId);

    OSStatus st = LSSetDefaultHandlerForURLScheme(CFSTR("mailto"), (__bridge CFStringRef)bundleId);

    // Poll rather than trust the status: older macOS can put a consent dialog
    // in front of the write, and the process has to outlive it.
    BOOL ours = NO;
    for (int i = 0; i < 120 && !ours; i++) {
      CFStringRef current = LSCopyDefaultHandlerForURLScheme(CFSTR("mailto"));
      if (current) {
        ours = [(__bridge NSString *)current caseInsensitiveCompare:bundleId] == NSOrderedSame;
        CFRelease(current);
      }
      if (!ours) [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
    }

    NSLog(@"MailVault default mail helper: OSStatus %d, handler is ours: %@", (int)st,
          ours ? @"yes" : @"no");
    return ours ? 0 : 1;
  }
}
