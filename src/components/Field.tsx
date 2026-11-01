/**
 * Labelled text field used by the provider editor.
 *
 * `reveal` is called on focus so the screen can scroll the field into the
 * keyboard-shrunk viewport (Android draws edge-to-edge, so the keyboard is not
 * a resize event — see `hooks/useKeyboardAwareScroll`).
 */
import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputInstance } from 'react-native';

import { theme } from '../theme';

export function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  reveal,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  keyboardType?: 'number-pad' | 'default';
  autoCapitalize?: 'none' | 'sentences';
  autoCorrect?: boolean;
  reveal: (target: TextInputInstance | null) => void;
}) {
  const inputRef = useRef<TextInputInstance>(null);
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        ref={inputRef}
        style={[styles.field, focused ? styles.fieldFocused : undefined]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={autoCorrect ?? true}
        accessibilityLabel={label}
        selectionColor={theme.accent}
        onFocus={() => {
          setFocused(true);
          reveal(inputRef.current);
        }}
        onBlur={() => setFocused(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fieldRow: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: theme.subtle,
  },
  field: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    color: theme.text,
    backgroundColor: theme.card,
  },
  fieldFocused: {
    borderColor: theme.accent,
    borderWidth: 2,
  },
});
