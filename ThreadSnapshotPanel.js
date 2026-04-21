/**
 * ThreadSnapshotPanel — shows aggregated thread heartbeat data for one target.
 *
 * @param {object} props
 * @param {{hack:number, grow:number, weaken:number, total:number, producers:number, tags:string[]}} props.summary
 * @param {number} props.lastUpdated
 * @param {Record<string, object>} props.styles
 */
export function ThreadSnapshotPanel({ summary, lastUpdated, styles }) {
  const e = React.createElement;

  const tagLine = summary.tags.length > 0 ? summary.tags.join(", ") : "(none)";

  return e(
    React.Fragment,
    null,
    e("div", { style: styles.sectionGap }),
    e("p", { style: styles.sectionTitle }, "Active thread snapshot"),
    e("p", { style: styles.line }, "Total threads: " + summary.total),
    e("p", { style: styles.line }, "Hack: " + summary.hack),
    e("p", { style: styles.line }, "Grow: " + summary.grow),
    e("p", { style: styles.line }, "Weaken: " + summary.weaken),
    e("p", { style: styles.line }, "Reporting hosts: " + summary.producers),
    e("p", { style: styles.line }, "Instances: " + tagLine),
    e("p", { style: styles.footer }, "Last refresh: " + new Date(lastUpdated).toLocaleTimeString()),
  );
}
