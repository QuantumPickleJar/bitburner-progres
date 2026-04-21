/**
 * CarouselHeader — navigation bar with prev/next buttons and a dropdown selector.
 *
 * @param {object} props
 * @param {string[]} props.servers
 * @param {number} props.index
 * @param {() => void} props.onPrev
 * @param {() => void} props.onNext
 * @param {(event: any) => void} props.onSelect
 * @param {Record<string, object>} props.styles
 */
export function CarouselHeader({ servers, index, onPrev, onNext, onSelect, styles }) {
  const e = React.createElement;

  const options = servers.map((host, i) =>
    e("option", { key: host, value: String(i) }, host),
  );

  return e(
    "div",
    { style: styles.headerRow },
    e("button", { style: styles.button, onClick: onPrev }, "\u25C0"),
    e(
      "select",
      {
        style: styles.select,
        value: String(index),
        onChange: onSelect,
      },
      ...options,
    ),
    e("button", { style: styles.button, onClick: onNext }, "\u25B6"),
  );
}
