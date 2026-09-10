import React from 'react';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

/**
 * Dynamic-name icon wrapper.
 *
 * `@expo/vector-icons` types the `name` prop as a giant string-literal
 * union of all glyphs. Screens that pull icon names from data ("each
 * row has its own icon") give TS a plain `string` and the assignment
 * fails with TS2322.
 *
 * Centralizing the cast here means we don't sprinkle `as never` across
 * dozens of call sites. The runtime is unchanged — invalid names just
 * render the missing-glyph "?" box, same as if you'd typed it directly.
 */
type IconProps = React.ComponentProps<typeof Icon>;

interface DynIconProps extends Omit<IconProps, 'name'> {
  name: string;
}

export function DynIcon({name, ...rest}: DynIconProps): React.JSX.Element {
  return <Icon name={name as IconProps['name']} {...rest} />;
}
