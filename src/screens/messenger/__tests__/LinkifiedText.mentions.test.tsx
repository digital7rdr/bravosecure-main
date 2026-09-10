/**
 * Mention highlighting in the message-body renderer, rendered for real.
 *
 * The pure segmentation rules are pinned in mentionText.test.ts. What THIS file
 * pins is the part only a render can see: that the mention actually reaches the
 * screen as its own styled span, that a mention of the VIEWER is emphasised
 * more than a mention of someone else, and — the case most likely to regress —
 * that adding mentions did not break URL linkification, since the two passes
 * now compose inside one component.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import {Text} from 'react-native';
import {LinkifiedText} from '@/modules/messenger/ui/LinkifiedText';

const MENTIONS = [
  {userId: 'u-alice', label: 'Alice'},
  {userId: 'u-bob', label: 'Bob Rani'},
];

/** Flattened text of every rendered Text node, in order. */
function texts(tree: ReturnType<typeof render>): string[] {
  return tree.UNSAFE_getAllByType(Text)
    .map(n => (typeof n.props.children === 'string' ? n.props.children : null))
    .filter((s): s is string => s !== null);
}

/** The style object applied to the node whose text is exactly `t`. */
function styleOf(tree: ReturnType<typeof render>, t: string): Record<string, unknown> {
  const node = tree.UNSAFE_getAllByType(Text).find(n => n.props.children === t);
  if (!node) {throw new Error(`no Text node rendering exactly ${JSON.stringify(t)}`);}
  const s = node.props.style;
  return Object.assign({}, ...(Array.isArray(s) ? s.flat(Infinity) : [s]).filter(Boolean));
}

describe('no mentions — the untouched path', () => {
  it('renders plain text as a single node', () => {
    const tree = render(<LinkifiedText text="just a message" linkColor="#fff" />);
    expect(texts(tree)).toContain('just a message');
  });

  it('still linkifies URLs when no mentions are present', () => {
    const tree = render(<LinkifiedText text="see https://bravo.example now" linkColor="#A9C5FF" />);
    expect(texts(tree)).toContain('https://bravo.example');
    expect(styleOf(tree, 'https://bravo.example')).toMatchObject({textDecorationLine: 'underline'});
  });

  it('treats an empty mention list as no mentions', () => {
    const tree = render(<LinkifiedText text="hi @Alice" linkColor="#fff" mentions={[]} />);
    expect(texts(tree)).toContain('hi @Alice');
  });
});

describe('mentions', () => {
  it('renders the mention as its OWN span, tinted', () => {
    const tree = render(
      <LinkifiedText text="hey @Alice how are you" linkColor="#fff" mentionColor="#5B8DEF" mentions={MENTIONS} />,
    );
    expect(texts(tree)).toEqual(expect.arrayContaining(['hey ', '@Alice', ' how are you']));
    expect(styleOf(tree, '@Alice')).toMatchObject({color: '#5B8DEF'});
  });

  it('is distinguishable by MORE than colour — weight + chip background', () => {
    // Founder report on vc166: on the outgoing cobalt bubble the tint has to
    // stay near-white to remain legible, which made it identical to the body
    // text and the mention invisible. Colour alone is also a WCAG 1.4.1 fail.
    const tree = render(
      <LinkifiedText
        text="@Alice"
        linkColor="#FFFFFF"
        mentionColor="#FFFFFF"
        mentionChipColor="rgba(255,255,255,0.22)"
        mentions={MENTIONS}
      />,
    );
    const s = styleOf(tree, '@Alice');
    expect(s.backgroundColor).toBe('rgba(255,255,255,0.22)');
    expect(s.fontWeight).toBeTruthy();
  });

  it('the chip background defaults to a translucent white when none is given', () => {
    const tree = render(<LinkifiedText text="@Alice" linkColor="#fff" mentions={MENTIONS} />);
    expect(styleOf(tree, '@Alice').backgroundColor).toBe('rgba(255,255,255,0.18)');
  });

  it('emphasises a mention OF THE VIEWER more than one of someone else', () => {
    // The whole reason to highlight is to find the line addressed to you when
    // scrolling back through a busy group.
    const mine = render(
      <LinkifiedText text="@Alice" linkColor="#fff" mentions={MENTIONS} selfUserId="u-alice" />,
    );
    const theirs = render(
      <LinkifiedText text="@Alice" linkColor="#fff" mentions={MENTIONS} selfUserId="u-bob" />,
    );
    expect(styleOf(mine, '@Alice').fontWeight).toBe('800');
    expect(styleOf(theirs, '@Alice').fontWeight).toBe('600');
  });

  it('falls back to linkColor when no mentionColor is given', () => {
    const tree = render(<LinkifiedText text="@Alice" linkColor="#ABCDEF" mentions={MENTIONS} />);
    expect(styleOf(tree, '@Alice')).toMatchObject({color: '#ABCDEF'});
  });

  it('labels the span for a screen reader as one unit', () => {
    const tree = render(<LinkifiedText text="@Alice" linkColor="#fff" mentions={MENTIONS} />);
    expect(tree.getByLabelText('mention Alice')).toBeTruthy();
  });

  it('handles a multi-word name without splitting it', () => {
    const tree = render(<LinkifiedText text="ping @Bob Rani ok" linkColor="#fff" mentions={MENTIONS} />);
    expect(texts(tree)).toEqual(expect.arrayContaining(['@Bob Rani']));
  });

  it('renders BOTH a mention and a URL in the same body', () => {
    // The composition case. Mentions segment first, then each remaining run is
    // linkified — if that order were reversed the URL pass could claim part of
    // a name containing a dot and split the highlight in half.
    const tree = render(
      <LinkifiedText
        text="@Alice see https://bravo.example"
        linkColor="#A9C5FF"
        mentionColor="#5B8DEF"
        mentions={MENTIONS}
      />,
    );
    expect(styleOf(tree, '@Alice')).toMatchObject({color: '#5B8DEF'});
    expect(styleOf(tree, 'https://bravo.example')).toMatchObject({textDecorationLine: 'underline'});
  });

  it('does NOT highlight an @ that matches no known label', () => {
    const tree = render(<LinkifiedText text="write to a@b.com" linkColor="#fff" mentions={MENTIONS} />);
    expect(() => styleOf(tree, '@b')).toThrow();
  });

  it('loses no characters — the rendered runs reassemble to the original body', () => {
    const body = 'a @Alice b @Bob Rani c';
    const tree = render(<LinkifiedText text={body} linkColor="#fff" mentions={MENTIONS} />);
    expect(texts(tree).join('')).toBe(body);
  });
});
