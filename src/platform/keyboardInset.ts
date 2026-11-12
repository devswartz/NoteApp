// How much of the on-screen keyboard the page still has to make room for (the native shells set it as
// --keyboard-inset on <html>). Pure, so tests/keyboardInset.test.ts runs it in node.
//
// The Capacitor Keyboard plugin reports the keyboard's height, but what the web view does about it depends on its
// resize mode. The app uses `resize: 'native'`: the web view itself gets shorter by the keyboard's height, so the page
// already has exactly the space between the top bar and the keyboard, and padding it by the keyboard's height again
// squeezes the content to a line or two. With no resizing (or a Safari-like scroll) the web view keeps its height and
// the page does need the padding. So only the part the web view did not give up is added.

/**
 * @param keyboardHeight what the keyboard plugin reported
 * @param heightBefore the web view's height (`window.innerHeight`) before the keyboard opened
 * @param heightNow its height now
 */
export function keyboardInset(keyboardHeight: number, heightBefore: number, heightNow: number): number {
  const alreadyGivenUp = Math.max(0, heightBefore - heightNow);
  return Math.max(0, Math.round(keyboardHeight - alreadyGivenUp));
}
