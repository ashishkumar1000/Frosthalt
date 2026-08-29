//
//  SecureTextFieldFix.mm
//  Frosthalt-macOS
//
//  Hotfix: restore change events from secure TextInputs on macOS 12+
//  (found on the first real `pnpm macos` run of Story 6.2; pre-existing —
//  every secureTextEntry field since 3.1 is affected).
//
//  react-native-macos's RCTUISecureTextField (Libraries/Text/TextInput/
//  Singleline/macOS/) subclasses RCTUITextField : NSTextField — NOT
//  NSSecureTextField — and only swaps the cell to an NSSecureTextFieldCell
//  (the PR #612 design). macOS 12+ requires the secure field editor's
//  delegate to be a real NSSecureTextField, with two consequences for our
//  non-secure-subclass fields:
//    1. Programmatic .focus() asserts and crashes (fixed app-side in
//       PasswordGate.tsx — never auto-focus a secure field).
//    2. The secure field editor silently never notifies a plain-NSTextField
//       delegate: typing updates the dots in the field, but NSTextField's
//       textDidChange: never runs, RN's RCTBackedTextFieldDelegateAdapter
//       never hears about it, onChangeText never fires, and React's
//       controlled value stays empty. Symptom: the gate's Verify button
//       never enables; SetPassword/ChangePassword are equally affected
//       (Show mode — a plain field — works, which is how passwords ever got
//       set at all).
//
//  Fix: this category observes AppKit's public NSTextDidChangeNotification
//  (posted by the field editor on every keystroke regardless of the
//  delegate wiring) and, when the posting editor is THIS field's
//  currentEditor, calls the field's own textDidChange: — the exact override
//  (RCTUITextField.mm) AppKit would have invoked on the working plain-field
//  path. That forwards into RN's adapter and re-fires the whole onChange
//  chain, including the native event-count bookkeeping that keeps the
//  controlled value in sync.
//
//  A category can safely ADD a method the class does not implement (only
//  replacing an existing method of the SAME class via a category is
//  undefined), so initWithFrame: here is found before the inherited
//  RCTUITextField one and still calls it via super.
//
//  Registered in project.pbxproj directly (the MenuBar/ShellRunner pattern)
//  — no Xcode GUI step needed.
//

#import <AppKit/AppKit.h>
#import <React/RCTUISecureTextField.h>

@implementation RCTUISecureTextField (FrosthaltSecureChangeEvents)

// The class itself does not implement initWithFrame: (it inherits
// RCTUITextField's), so this category method is found first and super still
// runs the inherited implementation — which wires RN's delegate adapter and
// everything else the field needs.
- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(frosthaltEditorTextDidChange:)
                                                 name:NSTextDidChangeNotification
                                               object:nil];
  }
  return self;
}

// Forward the field editor's change notification into the normal RN path.
// `textDidChange:` is RCTUITextField's own override (declared on NSTextField,
// NSTextField.h): it calls super (NSControl: posts
// NSControlTextDidChangeNotification) and notifies RN's adapter, which drives
// onChangeText in JS. The object: filter keeps other editors' notifications
// (e.g. plain fields in the same window) out; only THIS field's active
// editor matches currentEditor. If AppKit ever also delivers the delegate
// path itself, the duplicate event carries identical text and is harmless.
- (void)frosthaltEditorTextDidChange:(NSNotification *)notification
{
  if (notification.object == self.currentEditor) {
    [self textDidChange:notification];
  }
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

@end