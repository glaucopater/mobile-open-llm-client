/**
 * Bottom padding that keeps a composer or focused field above the keyboard.
 *
 * `KeyboardAvoidingView` cannot be used here: Android draws edge-to-edge since
 * SDK 53, so `windowSoftInputMode="adjustResize"` never shrinks the window, and
 * RN's native keyboard payload reports `screenY` as the *visible frame bottom*
 * (`ReactRootView.checkForKeyboardEvents`) — a value that only equals the
 * keyboard's top once the window resized. KAV subtracts that from its own frame
 * and under-pads by roughly the system-bar height, which is how the composer
 * stayed covered. `endCoordinates.height` is the IME inset minus the system
 * bars, so callers add the safe-area bottom inset on top of it: the keyboard
 * covers the navigation bar too, and padding by the height alone left the
 * composer inset-height behind the keys (31px on the test phone).
 */
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

export function useKeyboardPadding(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // The keyboard re-emits while it stays visible (emoji or suggestion panel
    // toggles), so every show event is a fresh height, not a one-shot.
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      setHeight(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setHeight(0);
    });

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return height;
}
